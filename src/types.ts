export type BatchStatus = '生产中' | '待复核' | '可放行' | '隔离中' | '已放行' | '已报废'
export type DeviationStatus = '待调查' | '调查中' | '待复核' | '已关闭' | '已撤销'
export type DecisionType = '返工' | '报废' | '让步接收'
export type DeviationKind = '关键限值偏离' | '监控断档' | '手工登记'
export type FrequencyKind = 'interval' | 'continuous' | 'perBatch'
export type MonitoringEntryType = '实时' | '补录'

/**
 * 监控频率版本：每个控制点保存完整版本链。
 * 任意时刻 t 生效的频率 = effectiveFrom <= t 的最新版本（按生效时刻倒序）。
 * 改频只追加新版本，从不覆盖旧版本，因此改频只影响生效时刻之后的判定。
 */
export interface FrequencyVersion {
  id: string
  /** 生效时刻，本地墙面时间 yyyy-MM-ddTHH:mm */
  effectiveFrom: string
  /** 频率展示文本，如 "每30分钟" */
  label: string
  kind: FrequencyKind
  /** interval 类型的周期（分钟）；continuous / perBatch 不参与间隔判定 */
  intervalMinutes: number | null
  note: string
}

export interface NumericLimit {
  min: number | null
  max: number | null
  unit: string
}

export interface ProcessStep {
  id: string
  name: string
  equipment: string
  hazard: string
  controlPoint: string
  limit: string
  correctiveAction: string
  numericLimit: NumericLimit
  /** 频率版本链，按 effectiveFrom 升序排列 */
  frequencyVersions: FrequencyVersion[]
}

export interface MonitoringValue {
  id: string
  stepId: string
  value: number
  unit: string
  /** 读数对应的监测时刻（原始记录，只读，任何重算都不改它） */
  recordedAt: string
  /** 录入系统的时刻；晚于监测时刻即为补录，补录另记录入时间 */
  enteredAt: string
  entryType: MonitoringEntryType
  operator: string
}

export interface Batch {
  id: string
  product: string
  line: string
  quantity: number
  producedAt: string
  status: BatchStatus
  /** 因断档被自动冻结前的批次状态，解冻时恢复 */
  statusBeforeFreeze: BatchStatus | null
  isolationScope: string
  monitoring: MonitoringValue[]
  version: number
}

export interface Investigation {
  cause: string
  evidence: string
  decision: DecisionType
  reworkInstruction: string
}

export interface Deviation {
  id: string
  batchId: string
  stepId: string
  title: string
  severity: '一般' | '重大'
  status: DeviationStatus
  kind: DeviationKind
  owner: string
  openedAt: string
  dueDate: string
  investigation: Investigation
  reviewNote: string
  reviewer: string
  /** 断档偏差专用：断档窗口签名 batchId|stepId|start|end，重复重算不重复开偏差 */
  gapKey: string
  /** 登记断档窗口（按当时频率判定，登记即固定，不受后续改频影响） */
  gapFrom: string
  gapTo: string
  /** 断档是否已经质量人员确认（确认=冻结该次判定，之后改频不重算这一段） */
  gapConfirmed: boolean
  /** 撤销原因：频率变更后未确认断档经重算不再成立 */
  revokedReason: string
  /** 触发该偏差/限值偏离的读数 id */
  sourceReadingId: string
  version: number
}

export interface AuditEntry {
  id: string
  entity: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

/** 断档判定结果（派生数据，不持久化） */
export interface GapEvaluation {
  batchId: string
  stepId: string
  from: string
  to: string
  gapMinutes: number
  /** 判定所依据的频率版本（窗口起点当时生效的版本） */
  basisVersion: FrequencyVersion | null
  /** 断档发生时刻缺少已生效频率版本（升级前历史数据，需先回填） */
  missingVersion: boolean
  /** 已关联的偏差 id */
  deviationId: string | null
}

export interface BatchGate {
  releasable: boolean
  reasons: string[]
  gaps: GapEvaluation[]
  missingVersion: boolean
}
