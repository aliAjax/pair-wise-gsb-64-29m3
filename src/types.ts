export type BatchStatus = '生产中' | '待复核' | '可放行' | '隔离中' | '已放行' | '已报废'
export type DeviationStatus = '待调查' | '调查中' | '待复核' | '已关闭'
export type DecisionType = '返工' | '报废' | '让步接收'
export type FrequencyMode = 'timed' | 'perBatch' | 'continuous'

/**
 * 监控频率版本：控制矩阵、批次监测、偏差处置和放行结论共用的同一份频率依据。
 * intervalMinutes = 时间间隔（分钟）；null = 每批；0 = 连续记录（按1分钟间隔判定断档）。
 * 版本按 effectiveFrom 分段生效，改频新增版本只影响生效时刻之后的相邻读数判定。
 */
export interface FrequencyVersion {
  id: string
  stepId: string
  intervalMinutes: number | null
  mode: FrequencyMode
  effectiveFrom: string
  createdBy: string
  createdAt: string
  note: string
  /** 升级前历史数据回填的基线版本，仅作为判定依据，不代表当时真实受控 */
  backfilled?: boolean
}

export interface ProcessStep {
  id: string
  name: string
  equipment: string
  hazard: string
  controlPoint: string
  limit: string
  /** 仅供展示的频率文本；判定一律使用 frequencyVersions */
  frequency: string
  correctiveAction: string
  minValue?: number
  maxValue?: number
  unit?: string
}

export interface MonitoringValue {
  id: string
  stepId: string
  value: number
  unit: string
  /** 读数时刻（监测实际发生时间） */
  recordedAt: string
  operator: string
  /** 录入时刻：补录时与读数时刻分离；原有读数不改动 */
  enteredAt: string
  enteredBy: string
  backfilled: boolean
}

export type GapStatus = '未确认' | '已确认' | '已撤销'
export type GapEndKind = '读数' | '改频时刻'

/** 断档：相邻读数间隔超过当时生效频率所形成的监控空窗 */
export interface GapRecord {
  id: string
  /** 同一对相邻读数形成的断档使用稳定键，重复重算不重复开偏差 */
  key: string
  batchId: string
  stepId: string
  startAt: string
  endAt: string
  endKind: GapEndKind
  /** 断档跨越的各频率分段及各自超期间隔 */
  segments: Array<{ from: string; to: string; intervalMinutes: number | null; overdueMinutes: number }>
  overdueMinutes: number
  status: GapStatus
  firstDetectedAt: string
  /** 重算版本号：每次频率依据变化递增 */
  revision: number
  lastRecomputedAt: string
  deviationId: string | null
  resolvedAt: string | null
}

export interface Batch {
  id: string
  product: string
  line: string
  quantity: number
  producedAt: string
  status: BatchStatus
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
  owner: string
  openedAt: string
  dueDate: string
  investigation: Investigation
  reviewNote: string
  reviewer: string
  version: number
  /** 限值类（原有）还是监控断档类（频率依据派生） */
  kind: '限值偏离' | '监控断档'
  /** 断档类偏差关联的断档稳定键，保证幂等 */
  gapKey?: string
  /** 断档是否包含补录读数（决定复核是否要求补录后合格读数） */
  backfillRequired?: boolean
}

export interface AuditEntry {
  id: string
  entity: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

export interface ReleaseEvaluation {
  ready: boolean
  reasons: string[]
  missingBasis: Array<{ stepId: string; stepName: string; recordedAt: string }>
  openGaps: GapRecord[]
  openDeviations: Deviation[]
  pendingResolution: Array<{ gap: GapRecord; reason: string }>
}
