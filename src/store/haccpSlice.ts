import { createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'
import { seedAudit, seedBatches, seedDeviations, processSteps } from '../data/seed'
import type {
  AuditEntry, Batch, BatchStatus, Deviation, DeviationStatus, FrequencyVersion,
  Investigation, MonitoringValue, ProcessStep,
} from '../types'
import {
  effectiveFrequency, evaluateBatchRelease, gapKey, isOutOfLimit, parseIntervalLabel,
} from '../services/frequencyEngine'

interface HaccpState {
  batches: Batch[]
  deviations: Deviation[]
  processSteps: ProcessStep[]
  audit: AuditEntry[]
  batchFilter: string
  batchStatus: BatchStatus | '全部'
  selectedBatchId: string | null
}
export type { HaccpState }

// v2：引入频率版本链与补录/断档模型；旧版本地状态不兼容，直接回到种子数据。
const STORAGE_KEY = 'gsb64:haccp-platform:v2'
const REVIEWER = '质量负责人 秦岚'
const TERMINAL: ReadonlySet<BatchStatus> = new Set(['已放行', '已报废'])

function nowLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

let idSeq = 0
function uid(prefix: string): string {
  idSeq = (idSeq + 1) % 100000
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}${nanoid(4)}`
}

function initialState(): HaccpState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.processSteps) && parsed.processSteps[0]?.frequencyVersions) return parsed
    }
  } catch {
    // 本地存储不可用或损坏时使用种子数据。
  }
  return {
    batches: structuredClone(seedBatches), deviations: structuredClone(seedDeviations),
    processSteps: structuredClone(processSteps), audit: structuredClone(seedAudit),
    batchFilter: '', batchStatus: '全部', selectedBatchId: seedBatches[0].id,
  }
}

// ---------------------------------------------------------------------------
// 断档重算（单一事实来源：services/frequencyEngine）
// 每次改频/回填/补录/新读数后执行：
//  - 新检出的断档窗口自动登记偏差并冻结批次；同一 gapKey 永不重复开单；
//  - 改频后未确认的断档若不再成立，撤销其偏差；已确认的断档不重算；
//  - 阻断解除且补录后有合格读数，批次回到放行流程。
// ---------------------------------------------------------------------------

function reconcile(state: HaccpState) {
  for (const batch of state.batches) {
    const evaluation = evaluateBatchRelease(batch, state.processSteps, state.deviations)

    // 1) 为新检出的断档窗口登记偏差（历史缺频率版本的窗口先不判定，等待回填）
    for (const gap of evaluation.gaps) {
      if (gap.missingVersion) continue
      const key = gapKey(batch.id, gap.stepId, gap.from, gap.to)
      const existing = state.deviations.find((d) => d.gapKey === key)
      if (existing) {
        // 重复重算不重复开偏差：若同窗口偏差此前因改频被撤销、现在窗口重新成立，则复活原单（同id）
        if (existing.status === '已撤销' && !existing.gapConfirmed) {
          existing.status = '待调查'
          existing.revokedReason = ''
          existing.version += 1
          log(state, existing.id, '断档重算复活', '系统判定',
            `频率版本变更后重算：${gap.from.slice(11, 16)}–${gap.to.slice(11, 16)}间隔${Math.round(gap.gapMinutes)}分钟再次超过当时频率「${gap.basisVersion?.label ?? ''}」，原偏差单恢复调查（不重复开单）`)
        }
        continue
      }
      const step = state.processSteps.find((s) => s.id === gap.stepId)
      const deviation: Deviation = {
        id: uid('DEV-'),
        batchId: batch.id, stepId: gap.stepId,
        title: `${step?.name ?? gap.stepId}监控断档${Math.round(gap.gapMinutes)}分钟`,
        severity: gap.gapMinutes >= 120 ? '重大' : '一般',
        status: '待调查', kind: '监控断档', owner: '当班生产班组',
        openedAt: nowLocal(), dueDate: nowLocal().slice(0, 10),
        investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
        reviewNote: '', reviewer: '', gapKey: key, gapFrom: gap.from, gapTo: gap.to,
        gapConfirmed: false, revokedReason: '', sourceReadingId: '', version: 1,
      }
      state.deviations.unshift(deviation)
      log(state, deviation.id, '断档自动登记', '系统判定',
        `${step?.name}相邻读数${gap.from.slice(11, 16)}与${gap.to.slice(11, 16)}间隔${Math.round(gap.gapMinutes)}分钟，超过当时频率「${gap.basisVersion?.label ?? ''}」；批次冻结放行并登记偏差`)
    }

    // 2) 频率版本变化后，未确认且不再成立的断档 → 撤销；已确认的判定固定不动
    for (const d of state.deviations) {
      if (d.batchId !== batch.id || d.kind !== '监控断档' || d.gapConfirmed) continue
      if (d.status === '已关闭' || d.status === '已撤销') continue
      const stillExists = evaluation.gaps.some((g) => !g.missingVersion && gapKey(batch.id, g.stepId, g.from, g.to) === d.gapKey)
      if (!stillExists) {
        d.status = '已撤销'
        d.revokedReason = '监控频率版本变更后重算：该相邻读数间隔未超过当时生效频率，断档不再成立'
        d.version += 1
        log(state, d.id, '断档重算撤销', '系统判定', d.revokedReason)
      }
    }
  }

  // 3) 冻结 / 回到放行流程（仅作用于非终态批次）
  for (const batch of state.batches) {
    if (TERMINAL.has(batch.status)) continue
    const blockers = state.deviations.filter((d) => d.batchId === batch.id && d.status !== '已关闭' && d.status !== '已撤销')
    const evaluation = evaluateBatchRelease(batch, state.processSteps, state.deviations)
    if (blockers.length > 0) {
      if (batch.status !== '隔离中') {
        batch.statusBeforeFreeze = batch.status
        batch.status = '隔离中'
        batch.version += 1
        log(state, batch.id, '冻结放行', '系统判定', `存在${blockers.length}项未关闭偏差/断档，冻结放行，隔离在制品`)
      }
    } else if (batch.status === '隔离中') {
      // 无未关闭偏差后，还须不存在“缺频率版本”且每个断档补录后有合格读数，才回到放行流程
      if (!evaluation.missingVersion && evaluation.gapsWithoutQualifiedReading.length === 0) {
        const restored = batch.statusBeforeFreeze && !TERMINAL.has(batch.statusBeforeFreeze) ? batch.statusBeforeFreeze : '待复核'
        batch.status = restored
        batch.statusBeforeFreeze = null
        batch.version += 1
        log(state, batch.id, '回到放行流程', '系统判定', '偏差已复核关闭且断档后已有合格读数，解除冻结回到放行流程')
      }
    }
  }
}

/** 复核通过前置条件：偏差涉及的读数时刻之后，该控制点至少有一个限值合格读数（纠偏/补录后复检合格）。 */
function readingMoment(state: HaccpState, deviation: Deviation): string {
  if (deviation.kind === '监控断档') return deviation.gapTo
  const batch = state.batches.find((b) => b.id === deviation.batchId)
  return batch?.monitoring.find((r) => r.id === deviation.sourceReadingId)?.recordedAt ?? ''
}

function qualifiedReadingAfter(state: HaccpState, deviation: Deviation): boolean {
  if (deviation.kind === '手工登记') return true
  const threshold = readingMoment(state, deviation)
  const step = state.processSteps.find((s) => s.id === deviation.stepId)
  const batch = state.batches.find((b) => b.id === deviation.batchId)
  if (!step || !batch || !threshold) return false
  // 断档：结束断档的那次（补录）读数即恢复监控证据，允许 >=；限值偏离：偏离读数本身不算，须 >。
  const cmp = (t: string) => (deviation.kind === '监控断档' ? t >= threshold : t > threshold)
  return batch.monitoring.some(
    (r) => r.stepId === deviation.stepId && cmp(r.recordedAt) && !isOutOfLimit(r.value, step.numericLimit),
  )
}

const slice = createSlice({
  name: 'haccp',
  initialState,
  reducers: {
    setBatchFilter(state, action: PayloadAction<string>) { state.batchFilter = action.payload },
    setBatchStatus(state, action: PayloadAction<BatchStatus | '全部'>) { state.batchStatus = action.payload },
    setSelectedBatch(state, action: PayloadAction<string | null>) { state.selectedBatchId = action.payload },

    updateProcessStep(state, action: PayloadAction<ProcessStep>) {
      const index = state.processSteps.findIndex((item) => item.id === action.payload.id)
      if (index < 0) return
      // 频率只能通过版本化动作修改，此处仅允许限值/纠偏等非频率字段
      action.payload.frequencyVersions = state.processSteps[index].frequencyVersions
      state.processSteps[index] = action.payload
      log(state, action.payload.id, '修改控制措施', '质量主管', `更新${action.payload.name}关键限值或纠偏措施（频率版本不受影响）`)
    },

    // 改频：追加新版本，只对生效时刻之后的判定有效；生效后未确认断档全部重算。
    changeFrequency(state, action: PayloadAction<{ stepId: string; effectiveFrom: string; label: string; note: string }>) {
      const step = state.processSteps.find((s) => s.id === action.payload.stepId)
      if (!step || !action.payload.label.trim()) return
      const latest = [...step.frequencyVersions].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
      if (latest && action.payload.effectiveFrom < latest.effectiveFrom) return // 改频不得早于最新版本；补历史请走回填
      const parsed = parseIntervalLabel(action.payload.label)
      if (parsed.kind === 'interval' && parsed.intervalMinutes === null) return
      const version: FrequencyVersion = {
        id: uid('FV-'), effectiveFrom: action.payload.effectiveFrom, label: action.payload.label.trim(),
        kind: parsed.kind, intervalMinutes: parsed.intervalMinutes, note: action.payload.note,
      }
      step.frequencyVersions.push(version)
      step.frequencyVersions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      log(state, step.id, '监控频率变更', '质量主管',
        `频率改为「${version.label}」，${version.effectiveFrom.replace('T', ' ')}起生效，只影响之后判定；未确认断档已重算`)
      reconcile(state)
    },

    // 回填升级前历史频率版本：允许生效时刻落在过去，回填后才允许判定历史窗口。
    backfillFrequency(state, action: PayloadAction<{ stepId: string; effectiveFrom: string; label: string; note: string }>) {
      const step = state.processSteps.find((s) => s.id === action.payload.stepId)
      if (!step || !action.payload.label.trim()) return
      const parsed = parseIntervalLabel(action.payload.label)
      if (parsed.kind === 'interval' && parsed.intervalMinutes === null) return
      const version: FrequencyVersion = {
        id: uid('FV-'), effectiveFrom: action.payload.effectiveFrom, label: action.payload.label.trim(),
        kind: parsed.kind, intervalMinutes: parsed.intervalMinutes, note: action.payload.note || '升级前历史频率回填',
      }
      step.frequencyVersions.push(version)
      step.frequencyVersions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      log(state, step.id, '回填历史频率版本', '质量主管',
        `回填「${version.label}」，追溯自${version.effectiveFrom.replace('T', ' ')}生效；历史断档按回填版本补判`)
      reconcile(state)
    },

    // 录入读数：补录另记 enteredAt，entryType 自动区分；任何已有读数均不改动。
    addReading(state, action: PayloadAction<{ batchId: string; stepId: string; value: number; recordedAt: string; enteredAt?: string; operator: string }>) {
      const batch = state.batches.find((b) => b.id === action.payload.batchId)
      const step = state.processSteps.find((s) => s.id === action.payload.stepId)
      if (!batch || !step || !action.payload.recordedAt) return
      const enteredAt = action.payload.enteredAt && action.payload.enteredAt > action.payload.recordedAt
        ? action.payload.enteredAt : nowLocal()
      const backfill = enteredAt.slice(0, 16) > action.payload.recordedAt.slice(0, 16)
      const reading: MonitoringValue = {
        id: uid('R-'), stepId: step.id, value: action.payload.value, unit: step.numericLimit.unit,
        recordedAt: action.payload.recordedAt, enteredAt, entryType: backfill ? '补录' : '实时',
        operator: action.payload.operator || '当班操作员',
      }
      batch.monitoring.push(reading)
      batch.version += 1
      log(state, reading.id, backfill ? '补录读数' : '实时录入读数', reading.operator,
        backfill
          ? `${step.name}读数${reading.value}${reading.unit}：监测时刻${reading.recordedAt.replace('T', ' ').slice(0, 16)}，录入时刻${enteredAt.replace('T', ' ').slice(0, 16)}，原有读数未改动`
          : `${step.name}读数${reading.value}${reading.unit}，监测时刻${reading.recordedAt.replace('T', ' ').slice(0, 16)}`)

      // 关键限值偏离：自动登记（限值判定仍保留，但不再是唯一监控约束）
      if (isOutOfLimit(reading.value, step.numericLimit)) {
        const exists = state.deviations.some((d) => d.sourceReadingId === reading.id)
        if (!exists) {
          const deviation: Deviation = {
            id: uid('DEV-'), batchId: batch.id, stepId: step.id,
            title: `${step.name}读数超出关键限值`, severity: '重大', status: '待调查',
            kind: '关键限值偏离', owner: '质量工程组', openedAt: nowLocal(),
            dueDate: nowLocal().slice(0, 10),
            investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
            reviewNote: '', reviewer: '', gapKey: '', gapFrom: '', gapTo: '',
            gapConfirmed: false, revokedReason: '', sourceReadingId: reading.id, version: 1,
          }
          state.deviations.unshift(deviation)
          log(state, deviation.id, '自动创建偏差', '系统判定',
            `${step.controlPoint}读数${reading.value}${reading.unit}超出限值（${step.limit}），批次冻结放行`)
        }
      }
      reconcile(state)
    },

    // 确认断档判定：确认后该次判定固定，之后改频不再重算/撤销。
    confirmGapDeviation(state, action: PayloadAction<{ id: string; note: string }>) {
      const deviation = state.deviations.find((d) => d.id === action.payload.id)
      if (!deviation || deviation.kind !== '监控断档' || deviation.gapConfirmed) return
      deviation.gapConfirmed = true
      deviation.version += 1
      log(state, deviation.id, '确认断档判定', '质量主管',
        `断档窗口${deviation.gapFrom.slice(11, 16)}–${deviation.gapTo.slice(11, 16)}判定已确认固定，后续改频不再重算该段${action.payload.note ? `；备注：${action.payload.note}` : ''}`)
    },

    createDeviation(state, action: PayloadAction<{ batchId: string; stepId: string; title: string; severity: '一般' | '重大'; owner: string }>) {
      const batch = state.batches.find((item) => item.id === action.payload.batchId)
      if (!batch) return
      const deviation: Deviation = {
        id: uid('DEV-'), ...action.payload, status: '待调查', kind: '手工登记', openedAt: nowLocal(),
        dueDate: nowLocal().slice(0, 10), reviewNote: '', reviewer: '', version: 1,
        investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
        gapKey: '', gapFrom: '', gapTo: '', gapConfirmed: false, revokedReason: '', sourceReadingId: '',
      }
      state.deviations.unshift(deviation)
      log(state, deviation.id, '手工登记偏差', '当前用户', `批次${batch.id}因${action.payload.title}登记偏差`)
      reconcile(state)
    },

    saveInvestigation(state, action: PayloadAction<{ id: string; investigation: Investigation }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.id)
      if (!deviation || deviation.status === '已关闭' || deviation.status === '已撤销') return
      if (!action.payload.investigation.cause.trim() || !action.payload.investigation.evidence.trim()) return
      deviation.investigation = action.payload.investigation
      deviation.status = '待复核'
      deviation.version += 1
      log(state, deviation.id, '提交偏差调查', deviation.owner, `处置分支：${deviation.investigation.decision}`)
    },

    reviewDeviation(state, action: PayloadAction<{ id: string; approved: boolean; note: string; reviewer: string }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.id)
      if (!deviation || deviation.status === '已关闭' || deviation.status === '已撤销') return
      if (action.payload.approved && !action.payload.note.trim()) return
      if (!action.payload.approved) {
        deviation.status = '调查中'
        deviation.reviewNote = action.payload.note
        deviation.reviewer = action.payload.reviewer
        deviation.version += 1
        log(state, deviation.id, '退回补证', action.payload.reviewer, action.payload.note || '退回调查')
        return
      }
      // 复核通过前置：断档/限值偏离之后必须有合格读数
      if (!qualifiedReadingAfter(state, deviation)) {
        log(state, deviation.id, '复核阻断', action.payload.reviewer,
          deviation.kind === '监控断档' ? '断档后尚无补录的合格读数，不能关闭偏差' : '偏离点之后尚无复检合格读数，不能关闭偏差')
        return
      }
      deviation.reviewNote = action.payload.note
      deviation.reviewer = action.payload.reviewer
      deviation.status = '已关闭'
      deviation.version += 1
      log(state, deviation.id, '复核通过', action.payload.reviewer, action.payload.note)

      const batch = state.batches.find((b) => b.id === deviation.batchId)
      if (batch && deviation.investigation.decision === '报废') {
        batch.status = '已报废'
        batch.statusBeforeFreeze = null
        batch.version += 1
        log(state, batch.id, '批次报废', action.payload.reviewer, `偏差${deviation.id}复核通过，按报废处置`)
        return
      }
      reconcile(state) // 解除冻结与否由统一重算决定（回到放行流程）
    },

    updateBatchStatus(state, action: PayloadAction<{ id: string; status: BatchStatus }>) {
      const batch = state.batches.find((item) => item.id === action.payload.id)
      if (!batch) return
      if (action.payload.status === '可放行') {
        // 放行结论的唯一依据：频率版本齐备 + 无未关闭偏差 + 断档后有合格读数
        const evaluation = evaluateBatchRelease(batch, state.processSteps, state.deviations)
        if (!evaluation.releasable) {
          log(state, batch.id, '放行阻断', '系统判定', evaluation.reasons.join('；'))
          return
        }
      }
      if (action.payload.status === '已放行' && batch.status !== '可放行') return
      batch.status = action.payload.status
      if (action.payload.status !== '隔离中') batch.statusBeforeFreeze = null
      batch.version += 1
      log(state, batch.id, '批次状态流转', '质量主管', `状态更新为${action.payload.status}`)
    },

    // 加载持久化状态后做一次幂等重算，保证旧数据上的断档判定与最新频率版本一致（不产生重复审计）。
    reconcileOnLoad(state) { reconcile(state) },

    resetDemo() {
      return {
        batches: structuredClone(seedBatches), deviations: structuredClone(seedDeviations),
        processSteps: structuredClone(processSteps), audit: structuredClone(seedAudit),
        batchFilter: '', batchStatus: '全部' as const, selectedBatchId: seedBatches[0].id,
      }
    },
  },
})

function log(state: HaccpState, entity: string, action: string, operator: string, detail: string) {
  state.audit.unshift({ id: nanoid(), entity, action, operator, detail, createdAt: nowLocal() })
}

export { nowLocal, REVIEWER, effectiveFrequency, qualifiedReadingAfter }
export const {
  setBatchFilter, setBatchStatus, setSelectedBatch, updateProcessStep, changeFrequency,
  backfillFrequency, addReading, confirmGapDeviation, createDeviation, saveInvestigation,
  reviewDeviation, updateBatchStatus, reconcileOnLoad, resetDemo,
} = slice.actions
export default slice.reducer
