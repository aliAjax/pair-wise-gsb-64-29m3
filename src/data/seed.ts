import type { AuditEntry, Batch, Deviation, ProcessStep } from '../types'

// 频率版本说明：
// - P1/P2/P5 为每批/连续监测，不参与相邻读数间隔判定；
// - P3 金属探测在 2026-09-29 系统升级后才建立频率版本，09-28 及更早的历史数据缺版本，须先回填；
// - P4 灌装封口于 09-29 08:00 由每60分钟加严为每30分钟，改频只影响之后。

export const processSteps: ProcessStep[] = [
  {
    id: 'P1', name: '原料验收', equipment: '冷藏收货台', hazard: '致病菌、温度失控', controlPoint: '原料中心温度',
    limit: '≤ 4 ℃', correctiveAction: '拒收并隔离供应商批次',
    numericLimit: { min: null, max: 4, unit: '℃' },
    frequencyVersions: [
      { id: 'FV-P1-1', effectiveFrom: '2026-09-01T00:00', label: '每批', kind: 'perBatch', intervalMinutes: null, note: '每供应商批次测温一次' }
    ]
  },
  {
    id: 'P2', name: '巴氏杀菌', equipment: 'HTST-02', hazard: '致病菌残留', controlPoint: '杀菌温度',
    limit: '≥ 72 ℃ / 15 s', correctiveAction: '自动回流并触发偏差',
    numericLimit: { min: 72, max: null, unit: '℃' },
    frequencyVersions: [
      { id: 'FV-P2-1', effectiveFrom: '2026-09-01T00:00', label: '连续记录', kind: 'continuous', intervalMinutes: null, note: '温控仪在线连续采集' }
    ]
  },
  {
    id: 'P3', name: '金属探测', equipment: 'MD-06', hazard: '金属异物', controlPoint: 'Fe/SUS灵敏度',
    limit: 'Fe ≤ 1.5 mm / SUS ≤ 2.0 mm', correctiveAction: '隔离末次合格点以来产品',
    numericLimit: { min: null, max: 1.5, unit: 'mm Fe' },
    frequencyVersions: [
      { id: 'FV-P3-1', effectiveFrom: '2026-09-29T00:00', label: '每30分钟', kind: 'interval', intervalMinutes: 30, note: '系统升级后建档；升级前频率需回填' }
    ]
  },
  {
    id: 'P4', name: '灌装封口', equipment: 'FILL-01', hazard: '密封不良', controlPoint: '封口压力',
    limit: '0.38-0.45 MPa', correctiveAction: '停机调机并复检留样',
    numericLimit: { min: 0.38, max: 0.45, unit: 'MPa' },
    frequencyVersions: [
      { id: 'FV-P4-1', effectiveFrom: '2026-09-01T00:00', label: '每60分钟', kind: 'interval', intervalMinutes: 60, note: '初版控制计划' },
      { id: 'FV-P4-2', effectiveFrom: '2026-09-29T08:00', label: '每30分钟', kind: 'interval', intervalMinutes: 30, note: '早班起加严监控，仅对08:00之后生效' }
    ]
  },
  {
    id: 'P5', name: '终产品冷却', equipment: '冷却隧道', hazard: '芽孢萌发', controlPoint: '冷却结束温度',
    limit: '≤ 10 ℃ / 2 h', correctiveAction: '延长冷却并观察质量',
    numericLimit: { min: null, max: 10, unit: '℃' },
    frequencyVersions: [
      { id: 'FV-P5-1', effectiveFrom: '2026-09-01T00:00', label: '每批', kind: 'perBatch', intervalMinutes: null, note: '每批次冷却结束测温' }
    ]
  }
]

export const seedBatches: Batch[] = [
  {
    id: 'B260929-01', product: '低温鲜奶 950mL', line: 'L1', quantity: 3200, producedAt: '2026-09-29T06:20:00',
    status: '隔离中', statusBeforeFreeze: '生产中', isolationScope: '杀菌后至金属探测前全部在制品', version: 5,
    monitoring: [
      { id: 'R-0101', stepId: 'P1', value: 3.4, unit: '℃', recordedAt: '2026-09-29T06:25:00', enteredAt: '2026-09-29T06:25:00', entryType: '实时', operator: '陈莉' },
      { id: 'R-0102', stepId: 'P2', value: 70.8, unit: '℃', recordedAt: '2026-09-29T06:48:00', enteredAt: '2026-09-29T06:48:00', entryType: '实时', operator: '系统采集' },
      { id: 'R-0103', stepId: 'P3', value: 1.5, unit: 'mm Fe', recordedAt: '2026-09-29T07:20:00', enteredAt: '2026-09-29T07:20:00', entryType: '实时', operator: '杨鸣' },
      // 班次繁忙漏测约2小时45分，10:05的读数为事后补录，录入时间10:12，原始监测时刻保留不改
      { id: 'R-0104', stepId: 'P3', value: 1.4, unit: 'mm Fe', recordedAt: '2026-09-29T10:05:00', enteredAt: '2026-09-29T10:12:00', entryType: '补录', operator: '杨鸣' }
    ]
  },
  {
    id: 'B260929-02', product: '原味酸奶 200g', line: 'L2', quantity: 8600, producedAt: '2026-09-29T08:10:00',
    status: '隔离中', statusBeforeFreeze: '生产中', isolationScope: 'FILL-01本次清洁后产品', version: 4,
    monitoring: [
      { id: 'R-0201', stepId: 'P4', value: 0.36, unit: 'MPa', recordedAt: '2026-09-29T08:40:00', enteredAt: '2026-09-29T08:40:00', entryType: '实时', operator: '系统采集' },
      { id: 'R-0202', stepId: 'P4', value: 0.37, unit: 'MPa', recordedAt: '2026-09-29T09:05:00', enteredAt: '2026-09-29T09:05:00', entryType: '实时', operator: '系统采集' },
      { id: 'R-0203', stepId: 'P4', value: 0.41, unit: 'MPa', recordedAt: '2026-09-29T09:30:00', enteredAt: '2026-09-29T09:30:00', entryType: '实时', operator: '赵雪' },
      // 补录读数：监测时刻09:55，10:20才录入，两条记录分别保留
      { id: 'R-0204', stepId: 'P4', value: 0.42, unit: 'MPa', recordedAt: '2026-09-29T09:55:00', enteredAt: '2026-09-29T10:20:00', entryType: '补录', operator: '赵雪' },
      { id: 'R-0205', stepId: 'P5', value: 8.2, unit: '℃', recordedAt: '2026-09-29T10:10:00', enteredAt: '2026-09-29T10:10:00', entryType: '实时', operator: '郑凯' }
    ]
  },
  {
    id: 'B260928-08', product: '高钙鲜奶 250mL', line: 'L1', quantity: 4400, producedAt: '2026-09-28T15:40:00',
    status: '生产中', statusBeforeFreeze: null, isolationScope: '无', version: 1,
    monitoring: [
      { id: 'R-0801', stepId: 'P3', value: 1.3, unit: 'mm Fe', recordedAt: '2026-09-28T16:00:00', enteredAt: '2026-09-28T16:00:00', entryType: '实时', operator: '夜班记录' },
      { id: 'R-0802', stepId: 'P3', value: 1.4, unit: 'mm Fe', recordedAt: '2026-09-28T16:25:00', enteredAt: '2026-09-28T16:25:00', entryType: '实时', operator: '夜班记录' },
      { id: 'R-0803', stepId: 'P1', value: 3.1, unit: '℃', recordedAt: '2026-09-28T16:05:00', enteredAt: '2026-09-28T16:05:00', entryType: '实时', operator: '夜班记录' },
      // P4 间隔50分钟：按当时每60分钟频率不构成断档（09-29 08:00加严为30分钟不溯及既往）
      { id: 'R-0804', stepId: 'P4', value: 0.41, unit: 'MPa', recordedAt: '2026-09-28T16:30:00', enteredAt: '2026-09-28T16:30:00', entryType: '实时', operator: '夜班记录' },
      { id: 'R-0805', stepId: 'P4', value: 0.42, unit: 'MPa', recordedAt: '2026-09-28T17:20:00', enteredAt: '2026-09-28T17:20:00', entryType: '实时', operator: '夜班记录' },
      { id: 'R-0806', stepId: 'P2', value: 73.5, unit: '℃', recordedAt: '2026-09-28T16:20:00', enteredAt: '2026-09-28T16:20:00', entryType: '实时', operator: '系统采集' },
      { id: 'R-0807', stepId: 'P5', value: 7.6, unit: '℃', recordedAt: '2026-09-28T18:00:00', enteredAt: '2026-09-28T18:00:00', entryType: '实时', operator: '夜班记录' }
    ]
  },
  {
    id: 'B260928-07', product: '低脂牛奶 1L', line: 'L1', quantity: 5100, producedAt: '2026-09-28T16:20:00',
    status: '已放行', statusBeforeFreeze: null, isolationScope: '无', version: 6,
    monitoring: processStepReadings('2026-09-28T17:00:00', [3.0, 73.2, 1.2, 0.41, 7.8])
  }
]

function processStepReadings(time: string, values: number[]) {
  const units = ['℃', '℃', 'mm Fe', 'MPa', '℃']
  return ['P1', 'P2', 'P3', 'P4', 'P5'].map((stepId, index) => ({
    id: `R-070${index + 1}`, stepId, value: values[index], unit: units[index],
    recordedAt: time, enteredAt: time, entryType: '实时' as const, operator: '生产线记录'
  }))
}

export const seedDeviations: Deviation[] = [
  {
    id: 'DEV-260929-01', batchId: 'B260929-01', stepId: 'P2', title: '杀菌温度低于关键限值', severity: '重大',
    status: '调查中', kind: '关键限值偏离', owner: '质量工程组', openedAt: '2026-09-29T06:55:00', dueDate: '2026-09-29',
    investigation: { cause: '蒸汽调节阀响应滞后', evidence: '趋势图显示70.8℃持续42秒；阀门检修记录已上传', decision: '返工', reworkInstruction: '隔离产品全部回流至平衡槽，重新杀菌并留样验证' },
    reviewNote: '', reviewer: '', gapKey: '', gapFrom: '', gapTo: '', gapConfirmed: false, revokedReason: '', sourceReadingId: 'R-0102', version: 3
  },
  {
    id: 'DEV-260929-02', batchId: 'B260929-02', stepId: 'P4', title: '封口压力低于关键限值', severity: '一般',
    status: '待复核', kind: '关键限值偏离', owner: '设备保障组', openedAt: '2026-09-29T08:52:00', dueDate: '2026-09-30',
    investigation: { cause: '气缸密封圈磨损', evidence: '压力曲线、拆检照片、备件领用单', decision: '返工', reworkInstruction: '更换密封圈，返封隔离产品并恢复压力。' },
    reviewNote: '', reviewer: '', gapKey: '', gapFrom: '', gapTo: '', gapConfirmed: false, revokedReason: '', sourceReadingId: 'R-0201', version: 2
  },
  {
    // 由断档判定自动登记：P3 07:20→10:05 间隔165分钟，超过当时每30分钟频率；窗口签名固定，重复重算不会重复开单
    id: 'DEV-260929-03', batchId: 'B260929-01', stepId: 'P3', title: '金属探测监控断档165分钟', severity: '重大',
    status: '待调查', kind: '监控断档', owner: '生产一班', openedAt: '2026-09-29T10:12:00', dueDate: '2026-09-29',
    investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
    reviewNote: '', reviewer: '',
    gapKey: 'B260929-01|P3|2026-09-29T07:20:00|2026-09-29T10:05:00',
    gapFrom: '2026-09-29T07:20:00', gapTo: '2026-09-29T10:05:00',
    gapConfirmed: false, revokedReason: '', sourceReadingId: 'R-0104', version: 1
  }
]

export const seedAudit: AuditEntry[] = [
  { id: 'AUD-1', entity: 'B260929-01', action: '自动创建偏差', operator: '监控系统', detail: '杀菌温度70.8℃低于限值72℃，批次已冻结放行', createdAt: '2026-09-29T06:55:00' },
  { id: 'AUD-2', entity: 'DEV-260929-01', action: '提交调查', operator: '质量工程组', detail: '记录蒸汽阀响应滞后与趋势证据', createdAt: '2026-09-29T08:15:00' },
  { id: 'AUD-3', entity: 'B260929-02', action: '自动创建偏差', operator: '监控系统', detail: '封口压力0.36MPa低于下限0.38MPa，批次已冻结放行', createdAt: '2026-09-29T08:52:00' },
  { id: 'AUD-4', entity: 'DEV-260929-03', action: '断档自动登记', operator: '监控系统', detail: 'P3相邻读数07:20与10:05间隔165分钟，超过当时频率每30分钟；批次冻结放行并登记偏差', createdAt: '2026-09-29T10:12:00' },
  { id: 'AUD-5', entity: 'R-0104', action: '补录读数', operator: '杨鸣', detail: '补录P3读数1.4mm Fe：监测时刻10:05，录入时刻10:12，原始读数未改动', createdAt: '2026-09-29T10:12:00' },
  { id: 'AUD-6', entity: 'R-0204', action: '补录读数', operator: '赵雪', detail: '补录P4读数0.42MPa：监测时刻09:55，录入时刻10:20，原始读数未改动', createdAt: '2026-09-29T10:20:00' },
  { id: 'AUD-7', entity: 'P4', action: '监控频率变更', operator: '质量主管', detail: '灌装封口频率每60分钟→每30分钟，2026-09-29T08:00生效，仅影响之后判定', createdAt: '2026-09-29T07:40:00' }
]
