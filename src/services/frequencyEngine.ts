import type { Batch, Deviation, FrequencyKind, FrequencyVersion, GapEvaluation, MonitoringValue, NumericLimit, ProcessStep } from '../types'

// ---------------------------------------------------------------------------
// 统一频率依据：控制矩阵 / 批次监测 / 偏差处置 / 放行结论共用本模块的判定。
// ---------------------------------------------------------------------------

export function minutesBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000
}

/** 时刻 t 生效的频率版本：effectiveFrom <= t 的最新一版；不存在则为 null（历史缺版本）。 */
export function effectiveFrequency(versions: FrequencyVersion[], t: string): FrequencyVersion | null {
  const sorted = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  let current: FrequencyVersion | null = null
  for (const v of sorted) {
    if (v.effectiveFrom <= t) current = v
    else break
  }
  return current
}

export function currentFrequency(versions: FrequencyVersion[], now: string = new Date().toISOString()): FrequencyVersion | null {
  return effectiveFrequency(versions, now)
}

let seq = 0
export function makeFrequencyVersion(effectiveFrom: string, label: string, kind: FrequencyKind, intervalMinutes: number | null, note = ''): FrequencyVersion {
  seq += 1
  return { id: `FV-${Date.now().toString(36)}-${seq}`, effectiveFrom, label, kind, intervalMinutes, note }
}

export function describeFrequency(v: FrequencyVersion | null): string {
  if (!v) return '缺频率版本（待回填）'
  return v.label
}

/** 解析“每N分钟/每半小时/每小时”这类频率文本，回填历史或文本输入时使用。 */
export function parseIntervalLabel(label: string): { kind: FrequencyKind; intervalMinutes: number | null } {
  const text = label.trim()
  if (/连续|在线|自动记录/.test(text)) return { kind: 'continuous', intervalMinutes: null }
  if (/每批/.test(text)) return { kind: 'perBatch', intervalMinutes: null }
  const numMatch = text.match(/(\d+(?:\.\d+)?)/)
  let minutes: number | null = null
  if (/半小?时/.test(text)) minutes = 30
  else if (/小?时/.test(text)) minutes = 60
  else if (numMatch && /分|分钟|min/i.test(text)) minutes = Number(numMatch[1])
  else if (numMatch) minutes = Number(numMatch[1]) * (/(小)?时/.test(text) ? 60 : 1)
  if (minutes && minutes > 0) return { kind: 'interval', intervalMinutes: minutes }
  return { kind: 'interval', intervalMinutes: null }
}

export function limitText(limit: NumericLimit): string {
  if (limit.min !== null && limit.max !== null) return `${limit.min}–${limit.max} ${limit.unit}`
  if (limit.min !== null) return `≥ ${limit.min} ${limit.unit}`
  if (limit.max !== null) return `≤ ${limit.max} ${limit.unit}`
  return limit.unit
}

export function isOutOfLimit(value: number, limit: NumericLimit): boolean {
  if (limit.min !== null && value < limit.min) return true
  if (limit.max !== null && value > limit.max) return true
  return false
}

// ---------------------------------------------------------------------------
// 断档判定：相邻读数间隔超过“窗口起点当时生效”的频率，即一段断档。
// 改频只影响之后：每个相邻间隔用其起点时刻的频率版本判定。
// ---------------------------------------------------------------------------

export function evaluateGaps(
  batch: Batch,
  steps: ProcessStep[],
  deviations: Deviation[],
): GapEvaluation[] {
  const gaps: GapEvaluation[] = []
  for (const step of steps) {
    const readings = batch.monitoring
      .filter((r) => r.stepId === step.id)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    if (readings.length < 2) continue
    for (let i = 1; i < readings.length; i += 1) {
      const prev = readings[i - 1]
      const curr = readings[i]
      // 判定依据 = 间隔起点（上一读数时刻）生效的频率
      const basis = effectiveFrequency(step.frequencyVersions, prev.recordedAt)
      if (!basis || basis.kind !== 'interval' || basis.intervalMinutes === null) {
        if (!basis) {
          gaps.push(makeGap(batch.id, step.id, prev, curr, null, true, deviations))
        }
        continue
      }
      const gapMinutes = minutesBetween(prev.recordedAt, curr.recordedAt)
      if (gapMinutes > basis.intervalMinutes) {
        gaps.push(makeGap(batch.id, step.id, prev, curr, basis, false, deviations))
      }
    }
  }
  return gaps
}

function makeGap(
  batchId: string,
  stepId: string,
  prev: MonitoringValue,
  curr: MonitoringValue,
  basis: FrequencyVersion | null,
  missingVersion: boolean,
  deviations: Deviation[],
): GapEvaluation {
  const key = gapKey(batchId, stepId, prev.recordedAt, curr.recordedAt)
  const deviation = deviations.find((d) => d.gapKey === key && d.status !== '已撤销') ?? null
  return {
    batchId,
    stepId,
    from: prev.recordedAt,
    to: curr.recordedAt,
    gapMinutes: minutesBetween(prev.recordedAt, curr.recordedAt),
    basisVersion: basis,
    missingVersion,
    deviationId: deviation?.id ?? null,
  }
}

/** 断档窗口的稳定签名：同一相邻读数对永远得到同一 key，重复重算不重复开偏差。 */
export function gapKey(batchId: string, stepId: string, from: string, to: string): string {
  return `${batchId}|${stepId}|${from}|${to}`
}

export interface BatchReleaseEvaluation {
  gaps: GapEvaluation[]
  /** 断档窗口内/之后缺少合格读数（断档未恢复） */
  gapsWithoutQualifiedReading: GapEvaluation[]
  openDeviations: Deviation[]
  missingVersion: boolean
  releasable: boolean
  reasons: string[]
}

/**
 * 放行结论的唯一判定入口：
 * 1) 不存在缺少已生效频率版本的历史窗口（必须先回填）；
 * 2) 无未关闭偏差；
 * 3) 每个断档窗口之后至少有一个限值合格的读数（补录后有合格读数）。
 */
export function evaluateBatchRelease(
  batch: Batch,
  steps: ProcessStep[],
  deviations: Deviation[],
): BatchReleaseEvaluation {
  const stepsById = new Map(steps.map((s) => [s.id, s]))
  const gaps = evaluateGaps(batch, steps, deviations)
  const missingVersion = gaps.some((g) => g.missingVersion)

  const gapsWithoutQualifiedReading = gaps.filter((g) => {
    if (g.missingVersion) return true
    const step = stepsById.get(g.stepId)
    if (!step) return true
    const afterGap = batch.monitoring
      .filter((r) => r.stepId === g.stepId && r.recordedAt >= g.to)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    return !afterGap.some((r) => !isOutOfLimit(r.value, step.numericLimit))
  })

  const openDeviations = deviations.filter((d) => d.batchId === batch.id && d.status !== '已关闭' && d.status !== '已撤销')

  const reasons: string[] = []
  if (missingVersion) reasons.push('存在升级前历史窗口缺少生效频率版本，须先回填频率版本后才能判定')
  for (const d of openDeviations) reasons.push(`偏差 ${d.id}（${d.title}）${d.status}，未关闭`)
  for (const g of gapsWithoutQualifiedReading) {
    if (g.missingVersion) continue
    const step = stepsById.get(g.stepId)
    reasons.push(`${step?.name ?? g.stepId} 在 ${g.from.slice(11, 16)}–${g.to.slice(11, 16)} 监控断档 ${Math.round(g.gapMinutes)} 分钟，补录后尚无合格读数`)
  }

  return {
    gaps,
    gapsWithoutQualifiedReading,
    openDeviations,
    missingVersion,
    releasable: reasons.length === 0,
    reasons,
  }
}
