import { createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'
import { seedAudit, seedBatches, seedDeviations, seedFrequencyVersions, processSteps, UPGRADE_AT } from '../data/seed'
import type { AuditEntry, Batch, BatchStatus, Deviation, DeviationStatus, FrequencyVersion, GapRecord, Investigation, MonitoringValue, ProcessStep } from '../types'
import { CONTINUOUS_INTERVAL, deriveGaps, evaluateValue, formatInterval, hasQualifiedReadingAfterBackfill } from '../services/frequency'

interface HaccpState {
  batches: Batch[]
  deviations: Deviation[]
  processSteps: ProcessStep[]
  frequencyVersions: FrequencyVersion[]
  gaps: GapRecord[]
  audit: AuditEntry[]
  batchFilter: string
  batchStatus: BatchStatus | '全部'
  selectedBatchId: string | null
}

const STORAGE_KEY = 'gsb64:haccp-platform'

/** 升级迁移：旧持久化数据补齐读数录入信息与频率版本基线，再参与判定 */
function migrate(parsed: Partial<HaccpState>): HaccpState {
  const batches: Batch[] = (parsed.batches ?? seedBatches).map((batch) => ({
    ...batch,
    monitoring: batch.monitoring.map((r) => {
      const reading = r as MonitoringValue
      return {
        id: reading.id ?? `R-${nanoid(6)}`,
        stepId: reading.stepId,
        value: reading.value,
        unit: reading.unit,
        recordedAt: reading.recordedAt,
        operator: reading.operator,
        enteredAt: reading.enteredAt ?? reading.recordedAt,
        enteredBy: reading.enteredBy ?? reading.operator,
        backfilled: reading.backfilled ?? false
      }
    })
  }))
  const deviations: Deviation[] = (parsed.deviations ?? seedDeviations).map((d) => ({ ...d, kind: d.kind ?? '限值偏离' }))
  return {
    batches,
    deviations,
    processSteps: parsed.processSteps ?? processSteps,
    frequencyVersions: parsed.frequencyVersions ?? seedFrequencyVersions,
    gaps: parsed.gaps ?? [],
    audit: parsed.audit ?? seedAudit,
    batchFilter: parsed.batchFilter ?? '',
    batchStatus: parsed.batchStatus ?? '全部',
    selectedBatchId: parsed.selectedBatchId ?? batches[0]?.id ?? null
  }
}

function initialState(): HaccpState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return migrate(JSON.parse(raw))
  } catch {
    // Seed data remains available when local storage is unavailable or corrupt.
  }
  return migrate({})
}

function log(state: HaccpState, entity: string, action: string, operator: string, detail: string, createdAt?: string) {
  state.audit.unshift({ id: nanoid(), entity, action, operator, detail, createdAt: createdAt ?? new Date().toISOString() })
}

function gapBlocksRelease(gap: GapRecord): boolean {
  return gap.status !== '已撤销' && gap.resolvedAt === null
}

function freezeBatch(state: HaccpState, batch: Batch, reason: string) {
  if (batch.status === '隔离中' || batch.status === '已放行' || batch.status === '已报废') return
  batch.status = '隔离中'
  batch.version += 1
  log(state, batch.id, '冻结放行', '频率判定引擎', reason)
}

function unfreezeIfClear(state: HaccpState, batch: Batch) {
  if (batch.status !== '隔离中') return
  const openGap = state.gaps.some((g) => g.batchId === batch.id && gapBlocksRelease(g))
  const openDeviation = state.deviations.some((d) => d.batchId === batch.id && d.status !== '已关闭')
  if (openGap || openDeviation) return
  batch.status = '待复核'
  batch.version += 1
  log(state, batch.id, '回到放行流程', '频率判定引擎', '断档与偏差均已闭环，批次恢复待复核')
}

function geometryChanged(a: GapRecord, b: { startAt: string; endAt: string; endKind: GapRecord['endKind']; overdueMinutes: number; segments: GapRecord['segments'] }): boolean {
  return a.startAt !== b.startAt || a.endAt !== b.endAt || a.endKind !== b.endKind || a.overdueMinutes !== b.overdueMinutes ||
    a.segments.length !== b.segments.length ||
    a.segments.some((s, i) => s.from !== b.segments[i].from || s.to !== b.segments[i].to || s.overdueMinutes !== b.segments[i].overdueMinutes)
}

function overlaps(a: { startAt: string; endAt: string }, b: { startAt: string; endAt: string }): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt
}

/**
 * 断档重算：以当前全部频率版本重新派生每个批次的断档。
 * - 身份匹配：先按稳定键（相邻读数对），再按同批次/控制点且时间区间重叠匹配，
 *   补录读数插在断档中间改变区间时仍是同一段断档，重复重算不重复开偏差。
 * - 频率/读数变化导致未确认断档不再成立（无任何重叠）→ 自动撤销。
 * - 已确认（已登记偏差）的断档只刷新几何信息，不重复开偏差、不自动重开。
 */
function recomputeGaps(state: HaccpState) {
  const now = new Date().toISOString()
  for (const batch of state.batches) {
    const derived = deriveGaps(batch.id, batch.monitoring, state.frequencyVersions)
    const matchedIds = new Set<string>()
    const applyExisting = (existing: GapRecord, d: ReturnType<typeof deriveGaps>[number], pointName: string, revived: boolean) => {
      matchedIds.add(existing.id)
      const changed = geometryChanged(existing, d) || existing.key !== d.key
      existing.key = d.key
      existing.startAt = d.startAt
      existing.endAt = d.endAt
      existing.endKind = d.endKind
      existing.segments = d.segments
      existing.overdueMinutes = d.overdueMinutes
      existing.lastRecomputedAt = now
      if (revived) existing.status = '未确认'
      if (existing.deviationId) {
        const linked = state.deviations.find((dev) => dev.id === existing.deviationId)
        if (linked) linked.gapKey = d.key
      }
      if (changed) {
        existing.revision += 1
        if (existing.status === '未确认') {
          log(state, batch.id, '断档判定重算', '频率判定引擎',
            `${pointName}断档依据频率/读数第${existing.revision}版重算，超时更新为${existing.overdueMinutes}分钟（结束于${existing.endKind === '改频时刻' ? '改频时刻' : '下一读数'}），同一段断档不重复开偏差`)
        } else {
          log(state, existing.id, '断档几何刷新', '频率判定引擎', `${pointName}断档已登记偏差，重算仅刷新时间区间，不重复开偏差`)
        }
      }
      if (existing.status === '未确认') freezeBatch(state, batch, `${pointName}监控断档未确认，先行冻结放行`)
    }

    // 第一遍：稳定键精确匹配（含已撤销：读数补录后判定再次成立时复活，不新开偏差）
    for (const d of derived) {
      const step = state.processSteps.find((s) => s.id === d.stepId)
      const pointName = step ? `${step.name}（${step.controlPoint}）` : d.stepId
      const exact = state.gaps.find((g) => g.batchId === batch.id && g.stepId === d.stepId && g.key === d.key && !matchedIds.has(g.id))
      if (exact) applyExisting(exact, d, pointName, exact.status === '已撤销')
    }
    // 第二遍：剩余派生断档按时间区间重叠匹配（补录拆分/合并时保持同一段断档身份）
    for (const d of derived) {
      const step = state.processSteps.find((s) => s.id === d.stepId)
      const pointName = step ? `${step.name}（${step.controlPoint}）` : d.stepId
      const candidates = state.gaps.filter((g) => g.batchId === batch.id && g.stepId === d.stepId && g.status !== '已撤销' && !matchedIds.has(g.id))
      const overlap = candidates.find((g) => overlaps(g, d))
      if (overlap) applyExisting(overlap, d, pointName, false)
    }
    // 仍未匹配的派生断档为新断档
    for (const d of derived) {
      const already = state.gaps.some((g) => g.batchId === batch.id && g.stepId === d.stepId && matchedIds.has(g.id) && (g.key === d.key || overlaps(g, d)))
      if (already) continue
      const step = state.processSteps.find((s) => s.id === d.stepId)
      const pointName = step ? `${step.name}（${step.controlPoint}）` : d.stepId
      const created: GapRecord = {
        id: nanoid(8),
        key: d.key,
        batchId: d.batchId,
        stepId: d.stepId,
        startAt: d.startAt,
        endAt: d.endAt,
        endKind: d.endKind,
        segments: d.segments,
        overdueMinutes: d.overdueMinutes,
        status: '未确认',
        firstDetectedAt: now,
        revision: 1,
        lastRecomputedAt: now,
        deviationId: null,
        resolvedAt: null
      }
      state.gaps.push(created)
      matchedIds.add(created.id)
      log(state, batch.id, '识别监控断档', '频率判定引擎',
        `${pointName}自${d.startAt.replace('T', ' ').slice(5, 16)}起相邻读数间隔超过当时频率，累计超时${d.overdueMinutes}分钟，批次冻结并待登记偏差`)
      freezeBatch(state, batch, `${pointName}监控断档未确认，先行冻结放行`)
    }

    for (const gap of state.gaps.filter((g) => g.batchId === batch.id && !matchedIds.has(g.id))) {
      if (gap.status !== '未确认') continue
      gap.status = '已撤销'
      gap.lastRecomputedAt = now
      gap.revision += 1
      const step = state.processSteps.find((s) => s.id === gap.stepId)
      log(state, batch.id, '撤销断档判定', '频率判定引擎',
        `${step?.name ?? gap.stepId}断档（${gap.key}）依据最新频率/读数重算后不再成立，未登记过偏差，判定撤销`)
    }
    unfreezeIfClear(state, batch)
  }
}

/** 断档窗口是否涉及补录读数 */
function gapInvolvesBackfill(state: HaccpState, gap: GapRecord): boolean {
  const batch = state.batches.find((b) => b.id === gap.batchId)
  if (!batch) return false
  return batch.monitoring.some((r) =>
    r.stepId === gap.stepId && r.backfilled && r.recordedAt >= gap.startAt && r.recordedAt <= gap.endAt)
}

const slice = createSlice({
  name: 'haccp',
  initialState,
  reducers: {
    setBatchFilter(state, action: PayloadAction<string>) { state.batchFilter = action.payload },
    setBatchStatus(state, action: PayloadAction<BatchStatus | '全部'>) { state.batchStatus = action.payload },
    setSelectedBatch(state, action: PayloadAction<string | null>) { state.selectedBatchId = action.payload },

    /** 改频：新增频率版本，按生效时刻分段，只影响生效之后的判定 */
    addFrequencyVersion(state, action: PayloadAction<{ stepId: string; intervalMinutes: number | null; mode: FrequencyVersion['mode']; effectiveFrom: string; note: string; createdBy?: string; backfilled?: boolean }>) {
      const payload = action.payload
      const step = state.processSteps.find((s) => s.id === payload.stepId)
      if (!step || !payload.effectiveFrom) return
      if (payload.mode === 'timed' && !((payload.intervalMinutes as number) > 0)) return
      const version: FrequencyVersion = {
        id: `FV-${nanoid(6)}`,
        stepId: payload.stepId,
        intervalMinutes: payload.mode === 'timed' ? payload.intervalMinutes : payload.mode === 'continuous' ? CONTINUOUS_INTERVAL : null,
        mode: payload.mode,
        effectiveFrom: payload.effectiveFrom,
        createdBy: payload.createdBy ?? '质量主管',
        createdAt: new Date().toISOString(),
        note: payload.note,
        backfilled: payload.backfilled
      }
      state.frequencyVersions.push(version)
      step.frequency = formatInterval(version.intervalMinutes)
      log(state, step.id, payload.backfilled ? '回填频率基线' : '监控频率变更', version.createdBy,
        payload.backfilled
          ? `回填历史频率基线：${formatInterval(version.intervalMinutes)}，生效于${version.effectiveFrom.replace('T', ' ').slice(0, 16)}；${payload.note}`
          : `频率改为${formatInterval(version.intervalMinutes)}，${version.effectiveFrom.replace('T', ' ').slice(0, 16)}起生效，改频只影响之后；${payload.note}`)
      recomputeGaps(state)
    },

    /** 录入/补录读数：补录另记录入时间，原有读数一律不改动 */
    addReading(state, action: PayloadAction<{ batchId: string; stepId: string; value: number; recordedAt: string; operator: string; entryMode?: 'auto' | 'timely' | 'backfill' }>) {
      const batch = state.batches.find((b) => b.id === action.payload.batchId)
      const step = state.processSteps.find((s) => s.id === action.payload.stepId)
      if (!batch || !step || !action.payload.recordedAt) return
      const now = new Date().toISOString()
      const backfilled = action.payload.entryMode === 'backfill'
        || (action.payload.entryMode !== 'timely' && new Date(action.payload.recordedAt).getTime() < Date.now() - 15 * 60000)
      const reading: MonitoringValue = {
        id: `R-${nanoid(8)}`,
        stepId: action.payload.stepId,
        value: action.payload.value,
        unit: step.unit ?? '',
        recordedAt: action.payload.recordedAt,
        operator: action.payload.operator || '当前用户',
        enteredAt: now,
        enteredBy: action.payload.operator || '当前用户',
        backfilled
      }
      batch.monitoring.push(reading)
      batch.version += 1
      log(state, batch.id, backfilled ? '补录监测读数' : '录入监测读数', reading.enteredBy,
        `${step.name}读数${reading.value}${reading.unit}，读数时刻${reading.recordedAt.replace('T', ' ').slice(5, 16)}，${backfilled ? `补录录入时刻${now.replace('T', ' ').slice(5, 16)}，` : ''}原有读数未改动`)
      recomputeGaps(state)
    },

    /** 未确认断档登记偏差（幂等：同一断档重复重算/登记只产生一张偏差单） */
    confirmGapDeviations(state, action: PayloadAction<{ keys: string[] }>) {
      for (const key of action.payload.keys) {
        const gap = state.gaps.find((g) => g.key === key)
        if (!gap || gap.status !== '未确认') continue
        if (gap.deviationId && state.deviations.some((d) => d.id === gap.deviationId)) continue
        const batch = state.batches.find((b) => b.id === gap.batchId)
        const step = state.processSteps.find((s) => s.id === gap.stepId)
        if (!batch || !step) continue
        const deviation: Deviation = {
          id: `DEV-G-${nanoid(6)}`,
          batchId: batch.id,
          stepId: step.id,
          title: `监控断档：${step.name}漏测超时${gap.overdueMinutes}分钟`,
          severity: gap.overdueMinutes >= 60 ? '重大' : '一般',
          status: '待调查',
          owner: '生产运行组',
          openedAt: new Date().toISOString(),
          dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
          investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
          reviewNote: '',
          reviewer: '',
          version: 1,
          kind: '监控断档',
          gapKey: gap.key,
          backfillRequired: gapInvolvesBackfill(state, gap)
        }
        state.deviations.unshift(deviation)
        gap.status = '已确认'
        gap.deviationId = deviation.id
        gap.lastRecomputedAt = new Date().toISOString()
        batch.version += 1
        log(state, deviation.id, '登记断档偏差', '质量主管',
          `批次${batch.id}在${step.name}存在${gap.overdueMinutes}分钟监控断档（判定修订V${gap.revision}），冻结期间产品不得放行${deviation.backfillRequired ? '，断档含补录读数，关闭前须确认补录后有合格读数' : ''}`)
      }
    },

    updateBatchStatus(state, action: PayloadAction<{ id: string; status: BatchStatus }>) {
      const batch = state.batches.find((item) => item.id === action.payload.id)
      if (!batch) return
      const blocking = state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭')
        || state.gaps.some((item) => item.batchId === batch.id && gapBlocksRelease(item))
      if ((action.payload.status === '可放行' || action.payload.status === '已放行') && blocking) {
        log(state, batch.id, '放行被阻止', '系统', `存在未关闭偏差或未闭环监控断档，拒绝流转为${action.payload.status}`)
        return
      }
      batch.status = action.payload.status
      batch.version += 1
      log(state, batch.id, '批次状态流转', '质量主管', `状态更新为${action.payload.status}`)
    },

    createDeviation(state, action: PayloadAction<{ batchId: string; stepId: string; title: string; severity: '一般' | '重大'; owner: string }>) {
      const batch = state.batches.find((item) => item.id === action.payload.batchId)
      if (!batch) return
      const now = new Date().toISOString()
      const deviation: Deviation = {
        id: `DEV-${Date.now().toString().slice(-8)}`, ...action.payload, status: '待调查', openedAt: now,
        dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), reviewNote: '', reviewer: '', version: 1,
        investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' }, kind: '限值偏离'
      }
      state.deviations.unshift(deviation)
      batch.status = '隔离中'
      batch.version += 1
      log(state, deviation.id, '创建偏差调查', '当前用户', `批次${batch.id}因${action.payload.title}进入隔离`)
    },

    saveInvestigation(state, action: PayloadAction<{ id: string; investigation: Investigation }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.id)
      if (!deviation || !action.payload.investigation.cause.trim() || !action.payload.investigation.evidence.trim()) return
      deviation.investigation = action.payload.investigation
      deviation.status = '待复核'
      deviation.version += 1
      if (deviation.kind === '监控断档') {
        const linkedGap = state.gaps.find((g) => g.key === deviation.gapKey)
        deviation.backfillRequired = linkedGap ? gapInvolvesBackfill(state, linkedGap) : deviation.backfillRequired
      }
      log(state, deviation.id, '提交偏差调查', deviation.owner, `处置分支：${deviation.investigation.decision}${deviation.backfillRequired ? '；含补录读数，复核须验证补录后合格读数' : ''}`)
    },

    reviewDeviation(state, action: PayloadAction<{ id: string; approved: boolean; note: string; reviewer: string }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.id)
      if (!deviation) return
      if (action.payload.approved && !action.payload.note.trim()) return
      const batch = state.batches.find((item) => item.id === deviation.batchId)

      if (action.payload.approved && deviation.kind === '监控断档' && deviation.gapKey) {
        const gap = state.gaps.find((g) => g.key === deviation.gapKey)
        if (gap && batch) {
          const needsBackfillProof = gapInvolvesBackfill(state, gap)
          if (needsBackfillProof && !hasQualifiedReadingAfterBackfill(gap, batch.monitoring, state.processSteps)) {
            log(state, deviation.id, '复核被阻止', action.payload.reviewer, '断档含补录读数，但补录后尚无合格读数，暂不能复核通过')
            return
          }
        }
      }

      deviation.reviewNote = action.payload.note
      deviation.reviewer = action.payload.reviewer
      deviation.status = action.payload.approved ? '已关闭' : '调查中'
      deviation.version += 1

      if (action.payload.approved && deviation.kind === '监控断档' && deviation.gapKey) {
        const gap = state.gaps.find((g) => g.key === deviation.gapKey)
        if (gap) {
          gap.resolvedAt = new Date().toISOString()
          log(state, gap.id, '断档闭环', action.payload.reviewer, '偏差复核通过且补录后合格读数已具备，断档闭环')
        }
      }

      if (batch && action.payload.approved && !state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭' && item.id !== deviation.id)) {
        if (deviation.investigation.decision === '报废') {
          batch.status = '已报废'
        } else if (deviation.kind === '监控断档') {
          unfreezeIfClear(state, batch)
        } else {
          batch.status = '待复核'
        }
        batch.version += 1
      }
      log(state, deviation.id, action.payload.approved ? '复核通过' : '退回补证', action.payload.reviewer, action.payload.note || '退回调查')
    },

    /** 启动后按当前频率依据重算一次（幂等，无变化不产生审计事件） */
    recalculateGaps(state) { recomputeGaps(state) },

    resetDemo() {
      const fresh: HaccpState = {
        batches: structuredClone(seedBatches),
        deviations: structuredClone(seedDeviations),
        processSteps: structuredClone(processSteps),
        frequencyVersions: structuredClone(seedFrequencyVersions),
        gaps: [],
        audit: structuredClone(seedAudit),
        batchFilter: '',
        batchStatus: '全部',
        selectedBatchId: seedBatches[0].id
      }
      recomputeGaps(fresh)
      return fresh
    }
  }
})

export const { setBatchFilter, setBatchStatus, setSelectedBatch, addFrequencyVersion, addReading, confirmGapDeviations, updateBatchStatus, createDeviation, saveInvestigation, reviewDeviation, recalculateGaps, resetDemo } = slice.actions
export { UPGRADE_AT, evaluateValue }
export default slice.reducer
