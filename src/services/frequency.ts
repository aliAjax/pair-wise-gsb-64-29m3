import type { FrequencyVersion, GapRecord, MonitoringValue, ProcessStep, ReleaseEvaluation, Batch, Deviation } from '../types'

/** 连续记录按 1 分钟最小判定间隔 */
export const CONTINUOUS_INTERVAL = 1

export function formatInterval(intervalMinutes: number | null): string {
  if (intervalMinutes === null) return '每批（无间隔判定）'
  if (intervalMinutes === CONTINUOUS_INTERVAL) return '连续记录（1分钟）'
  if (intervalMinutes % 60 === 0) return `每${intervalMinutes / 60}小时`
  return `每${intervalMinutes}分钟`
}

export function parseFrequencyText(text: string): { mode: FrequencyVersion['mode']; intervalMinutes: number | null } {
  if (text.includes('连续')) return { mode: 'continuous', intervalMinutes: CONTINUOUS_INTERVAL }
  if (text.includes('每批')) return { mode: 'perBatch', intervalMinutes: null }
  const hour = text.match(/([\d.]+)\s*小时/)
  if (hour) return { mode: 'timed', intervalMinutes: Math.round(Number(hour[1]) * 60) }
  const min = text.match(/([\d.]+)\s*分钟/)
  if (min) return { mode: 'timed', intervalMinutes: Math.round(Number(min[1])) }
  if (text.includes('半小时')) return { mode: 'timed', intervalMinutes: 30 }
  if (text.includes('小时')) return { mode: 'timed', intervalMinutes: 60 }
  return { mode: 'perBatch', intervalMinutes: null }
}

/** 取某一时刻生效的频率版本（生效时刻 <= t 中的最新一版；同一时刻取最后创建的版本） */
export function versionAt(versions: FrequencyVersion[], t: string): FrequencyVersion | undefined {
  let hit: FrequencyVersion | undefined
  for (const v of versions) {
    if (v.effectiveFrom > t) continue
    if (!hit || v.effectiveFrom > hit.effectiveFrom ||
      (v.effectiveFrom === hit.effectiveFrom && v.createdAt >= hit.createdAt)) hit = v
  }
  return hit
}

/** 读数间隔是否严格超过当时频率：相邻读数间隔 > 生效间隔，即一段断档 */
export function isOverdue(deltaMs: number, intervalMinutes: number): boolean {
  return deltaMs > intervalMinutes * 60000
}

export function evaluateValue(step: ProcessStep, value: number): boolean {
  if (step.minValue !== undefined && value < step.minValue) return false
  if (step.maxValue !== undefined && value > step.maxValue) return false
  return true
}

export interface DerivedGap {
  key: string
  batchId: string
  stepId: string
  startAt: string
  endAt: string
  endKind: GapRecord['endKind']
  segments: GapRecord['segments']
  overdueMinutes: number
}

/**
 * 以「当时生效的频率版本」切分每对相邻读数：
 * 读数 a(t1) → b(t2) 之间，按区间内版本生效时刻切小段，任一小段间隔 > 该段频率即超时，
 * 相邻超时小段合并成一段断档。改频（如放宽）落在中间时，断档可结束于改频时刻。
 */
export function deriveGaps(batchId: string, readings: MonitoringValue[], versions: FrequencyVersion[]): DerivedGap[] {
  const result: DerivedGap[] = []
  for (const stepId of new Set(readings.map((r) => r.stepId))) {
    const stepVersions = versions.filter((v) => v.stepId === stepId)
    const points = readings
      .filter((r) => r.stepId === stepId)
      .slice()
      .sort((x, y) => x.recordedAt.localeCompare(y.recordedAt))

    let carry: DerivedGap | null = null
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]
      const b = points[i + 1]
      const start = new Date(a.recordedAt)
      const end = new Date(b.recordedAt)
      const boundaries = stepVersions
        .map((v) => new Date(v.effectiveFrom))
        .filter((d) => d > start && d < end)
        .sort((x, y) => x.getTime() - y.getTime())
      const cuts = [start, ...boundaries, end]

      const overdueSubs: Array<{ from: Date; to: Date; intervalMinutes: number | null }> = []
      for (let k = 0; k < cuts.length - 1; k++) {
        const segFrom = cuts[k]
        const segTo = cuts[k + 1]
        const governing = versionAt(stepVersions, segFrom.toISOString())
        if (!governing || governing.intervalMinutes === null) continue
        if (isOverdue(segTo.getTime() - segFrom.getTime(), governing.intervalMinutes)) {
          overdueSubs.push({ from: segFrom, to: segTo, intervalMinutes: governing.intervalMinutes })
        }
      }
      if (overdueSubs.length === 0) {
        carry = null
        continue
      }
      const first = overdueSubs[0]
      const last = overdueSubs[overdueSubs.length - 1]
      const gap: DerivedGap = {
        key: `${batchId}|${stepId}|${a.recordedAt}`,
        batchId,
        stepId,
        startAt: first.from.toISOString(),
        endAt: last.to.toISOString(),
        endKind: last.to.getTime() === end.getTime() ? '读数' : '改频时刻',
        segments: overdueSubs.map((s) => ({
          from: s.from.toISOString(),
          to: s.to.toISOString(),
          intervalMinutes: s.intervalMinutes,
          overdueMinutes: Math.round((s.to.getTime() - s.from.getTime() - (s.intervalMinutes ?? 0) * 60000) / 60000)
        })),
        overdueMinutes: 0
      }
      gap.overdueMinutes = gap.segments.reduce((sum, s) => sum + s.overdueMinutes, 0)

      if (carry && carry.endAt === gap.startAt) {
        carry.endAt = gap.endAt
        carry.endKind = gap.endKind
        carry.segments.push(...gap.segments)
        carry.overdueMinutes += gap.overdueMinutes
      } else {
        if (carry) result.push(carry)
        carry = gap
      }
    }
    if (carry) result.push(carry)
  }
  return result
}

/** 缺少频率依据的读数：当时没有任何已生效频率版本（升级前历史数据未回填） */
export function findMissingBasis(readings: MonitoringValue[], steps: ProcessStep[], versions: FrequencyVersion[]) {
  const missing: ReleaseEvaluation['missingBasis'] = []
  for (const r of readings) {
    const step = steps.find((s) => s.id === r.stepId)
    if (!step) continue
    if (!versionAt(versions.filter((v) => v.stepId === r.stepId), r.recordedAt)) {
      missing.push({ stepId: r.stepId, stepName: step.name, recordedAt: r.recordedAt })
    }
  }
  return missing
}

/** 补录后是否存在合格读数：断档结束（含补录的读数）之后的常规、合格读数 */
export function hasQualifiedReadingAfterBackfill(
  gap: GapRecord,
  readings: MonitoringValue[],
  steps: ProcessStep[]
): boolean {
  const step = steps.find((s) => s.id === gap.stepId)
  if (!step) return false
  return readings.some((r) =>
    r.stepId === gap.stepId &&
    !r.backfilled &&
    r.recordedAt >= gap.endAt &&
    evaluateValue(step, r.value))
}

/** 放行结论：控制矩阵、批次监测、偏差处置全部挂到同一份频率依据上 */
export function evaluateRelease(
  batch: Batch,
  batches: Batch[],
  deviations: Deviation[],
  versions: FrequencyVersion[],
  steps: ProcessStep[],
  gaps: GapRecord[]
): ReleaseEvaluation {
  const reasons: string[] = []
  void batches

  const missing = findMissingBasis(batch.monitoring, steps, versions)
  if (missing.length > 0) {
    reasons.push(`${missing.length}条历史读数缺少生效频率版本，需先回填频率基线再判定`)
  }

  const batchGaps = gaps.filter((g) => g.batchId === batch.id)
  const openGaps = batchGaps.filter((g) => g.status !== '已撤销')
  const pendingResolution: ReleaseEvaluation['pendingResolution'] = []

  for (const gap of openGaps) {
    const step = steps.find((s) => s.id === gap.stepId)
    const name = step ? `${step.name}（${step.controlPoint}）` : gap.stepId
    if (gap.status === '未确认') {
      reasons.push(`${name}存在监控断档 ${gap.startAt.replace('T', ' ').slice(5, 16)} 起、超时${gap.overdueMinutes}分钟，批次已冻结`)
      pendingResolution.push({ gap, reason: '断档判定未确认，等待重算与偏差处置' })
    } else {
      const containsBackfill = batch.monitoring.some(
        (r) => r.stepId === gap.stepId && r.backfilled && r.recordedAt >= gap.startAt && r.recordedAt <= gap.endAt
      )
      if (containsBackfill && !hasQualifiedReadingAfterBackfill(gap, batch.monitoring, steps)) {
        reasons.push(`${name}断档已补录，但补录后尚无合格读数`)
        pendingResolution.push({ gap, reason: '补录后需有合格读数才能复核关闭' })
      }
    }
  }

  const openDeviations = deviations.filter((d) => d.batchId === batch.id && d.status !== '已关闭')
  for (const d of openDeviations) {
    reasons.push(`偏差 ${d.id}（${d.title}）未关闭`)
  }

  return { ready: reasons.length === 0, reasons, missingBasis: missing, openGaps, openDeviations, pendingResolution }
}
