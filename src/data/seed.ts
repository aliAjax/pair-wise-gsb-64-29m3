import type { AuditEntry, Batch, Deviation, FrequencyVersion, MonitoringValue, ProcessStep } from '../types'
import { CONTINUOUS_INTERVAL, parseFrequencyText } from '../services/frequency'

export const processSteps: ProcessStep[] = [
  { id: 'P1', name: '原料验收', equipment: '冷藏收货台', hazard: '致病菌、温度失控', controlPoint: '原料中心温度', limit: '≤ 4 ℃', frequency: '每批', correctiveAction: '拒收并隔离供应商批次', maxValue: 4, unit: '℃' },
  { id: 'P2', name: '巴氏杀菌', equipment: 'HTST-02', hazard: '致病菌残留', controlPoint: '杀菌温度', limit: '≥ 72 ℃ / 15 s', frequency: '连续记录', correctiveAction: '自动回流并触发偏差', minValue: 72, unit: '℃' },
  { id: 'P3', name: '金属探测', equipment: 'MD-06', hazard: '金属异物', controlPoint: 'Fe/SUS灵敏度', limit: 'Fe 1.5 mm / SUS 2.0 mm', frequency: '每半小时', correctiveAction: '隔离末次合格点以来产品', maxValue: 1.5, unit: 'mm Fe' },
  { id: 'P4', name: '灌装封口', equipment: 'FILL-01', hazard: '密封不良', controlPoint: '封口压力', limit: '0.38-0.45 MPa', frequency: '每小时', correctiveAction: '停机调机并复检留样', minValue: 0.38, maxValue: 0.45, unit: 'MPa' },
  { id: 'P5', name: '终产品冷却', equipment: '冷却隧道', hazard: '芽孢萌发', controlPoint: '冷却结束温度', limit: '≤ 10 ℃ / 2 h', frequency: '每批', correctiveAction: '延长冷却并观察质量', maxValue: 10, unit: '℃' }
]

const m = (input: Omit<MonitoringValue, 'enteredAt' | 'enteredBy' | 'backfilled'>): MonitoringValue => ({
  ...input,
  enteredAt: input.recordedAt,
  enteredBy: input.operator,
  backfilled: false
})

/**
 * 系统升级时刻：此前的历史读数没有频率版本。
 * P1-P4 用升级前生效的基线版本回填；P5 故意不回填，演示「先回填再判定」。
 */
export const UPGRADE_AT = '2026-09-29T00:00:00'

export const seedFrequencyVersions: FrequencyVersion[] = processSteps
  .filter((step) => step.id !== 'P5')
  .map((step) => {
    const parsed = parseFrequencyText(step.frequency)
    return {
      id: `FV-${step.id}-BASE`,
      stepId: step.id,
      intervalMinutes: parsed.mode === 'continuous' ? CONTINUOUS_INTERVAL : parsed.intervalMinutes,
      mode: parsed.mode,
      effectiveFrom: '2026-09-01T00:00:00',
      createdBy: '系统升级回填',
      createdAt: UPGRADE_AT,
      note: `升级前历史数据回填：${step.frequency}`,
      backfilled: true
    }
  })
  // P3 在 09-29 08:00 由每半小时放宽到每小时（改频只影响之后）
  .concat([
    {
      id: 'FV-P3-002',
      stepId: 'P3',
      intervalMinutes: 60,
      mode: 'timed',
      effectiveFrom: '2026-09-29T08:00:00',
      createdBy: '质量主管',
      createdAt: '2026-09-28T17:40:00',
      note: '设备稳定性验证完成，金属探测频率调整为每小时，09-29 08:00生效',
      backfilled: false
    }
  ])

export const seedBatches: Batch[] = [
  {
    id: 'B260929-01', product: '低温鲜奶 950mL', line: 'L1', quantity: 3200, producedAt: '2026-09-29T06:20:00', status: '隔离中', isolationScope: '杀菌后至金属探测前全部在制品', version: 4,
    monitoring: [
      m({ id: 'R-0101', stepId: 'P1', value: 3.4, unit: '℃', recordedAt: '2026-09-29T06:25:00', operator: '陈莉' }),
      m({ id: 'R-0102', stepId: 'P2', value: 70.8, unit: '℃', recordedAt: '2026-09-29T06:48:00', operator: '系统采集' }),
      // P3：06:55 → 09:20。06:55–08:00 适用30分钟（超时35分钟，断档）；
      // 08:00 改频为60分钟，08:00–09:20 为80分钟（超时20分钟），断档延续
      m({ id: 'R-0103', stepId: 'P3', value: 1.5, unit: 'mm Fe', recordedAt: '2026-09-29T06:55:00', operator: '杨鸣' }),
      m({ id: 'R-0104', stepId: 'P3', value: 1.2, unit: 'mm Fe', recordedAt: '2026-09-29T09:20:00', operator: '杨鸣' })
    ]
  },
  {
    id: 'B260929-02', product: '原味酸奶 200g', line: 'L2', quantity: 8600, producedAt: '2026-09-29T08:10:00', status: '待复核', isolationScope: 'FILL-01本次清洁后产品', version: 3,
    monitoring: [
      m({ id: 'R-0201', stepId: 'P4', value: 0.36, unit: 'MPa', recordedAt: '2026-09-29T08:40:00', operator: '系统采集' }),
      // P4 每小时：08:40 → 10:25 间隔105分钟，超时45分钟（忙产漏测两小时的断档）
      m({ id: 'R-0202', stepId: 'P4', value: 0.41, unit: 'MPa', recordedAt: '2026-09-29T10:25:00', operator: '郑凯' }),
      m({ id: 'R-0203', stepId: 'P5', value: 8.2, unit: '℃', recordedAt: '2026-09-29T10:10:00', operator: '郑凯' })
    ]
  },
  {
    // 升级前历史批次：读数均早于 UPGRADE_AT；P5 无回填版本 → 缺频率依据，不能直接判定
    id: 'B260928-07', product: '低脂牛奶 1L', line: 'L1', quantity: 5100, producedAt: '2026-09-28T16:20:00', status: '已放行', isolationScope: '无', version: 6,
    monitoring: [
      m({ id: 'R-0701', stepId: 'P1', value: 3.0, unit: '℃', recordedAt: '2026-09-28T16:25:00', operator: '生产线记录' }),
      m({ id: 'R-0702', stepId: 'P2', value: 73.2, unit: '℃', recordedAt: '2026-09-28T16:40:00', operator: '生产线记录' }),
      // P3 当时30分钟频率：16:40 → 17:40 = 60分钟，超时30分钟（回填后才判定出的历史断档）
      m({ id: 'R-0703', stepId: 'P3', value: 1.2, unit: 'mm Fe', recordedAt: '2026-09-28T16:40:00', operator: '生产线记录' }),
      m({ id: 'R-0704', stepId: 'P3', value: 1.3, unit: 'mm Fe', recordedAt: '2026-09-28T17:40:00', operator: '生产线记录' }),
      m({ id: 'R-0705', stepId: 'P4', value: 0.41, unit: 'MPa', recordedAt: '2026-09-28T17:00:00', operator: '生产线记录' }),
      m({ id: 'R-0706', stepId: 'P5', value: 7.8, unit: '℃', recordedAt: '2026-09-28T18:10:00', operator: '生产线记录' })
    ]
  }
]

export const seedDeviations: Deviation[] = [
  {
    id: 'DEV-260929-01', batchId: 'B260929-01', stepId: 'P2', title: '杀菌温度低于关键限值', severity: '重大', status: '调查中', owner: '质量工程组', openedAt: '2026-09-29T06:55:00', dueDate: '2026-09-29', version: 3, kind: '限值偏离',
    investigation: { cause: '蒸汽调节阀响应滞后', evidence: '趋势图显示70.8℃持续42秒；阀门检修记录已上传', decision: '返工', reworkInstruction: '隔离产品全部回流至平衡槽，重新杀菌并留样验证' }, reviewNote: '', reviewer: ''
  },
  {
    id: 'DEV-260929-02', batchId: 'B260929-02', stepId: 'P4', title: '封口压力偏低', severity: '一般', status: '待复核', owner: '设备保障组', openedAt: '2026-09-29T08:52:00', dueDate: '2026-09-30', version: 2, kind: '限值偏离',
    investigation: { cause: '气缸密封圈磨损', evidence: '压力曲线、拆检照片、备件领用单', decision: '返工', reworkInstruction: '更换密封圈，返封隔离产品并恢复压力。' }, reviewNote: '', reviewer: ''
  }
]

export const seedAudit: AuditEntry[] = [
  { id: 'AUD-1', entity: 'B260929-01', action: '自动创建偏差', operator: '监控系统', detail: '杀菌温度70.8℃低于限值72℃，批次已隔离', createdAt: '2026-09-29T06:55:00' },
  { id: 'AUD-2', entity: 'DEV-260929-01', action: '提交调查', operator: '质量工程组', detail: '记录蒸汽阀响应滞后与趋势证据', createdAt: '2026-09-29T08:15:00' },
  { id: 'AUD-3', entity: 'B260929-02', action: '状态流转', operator: '杨鸣', detail: '由生产中转为待复核', createdAt: '2026-09-29T08:52:00' },
  { id: 'AUD-4', entity: '频率版本', action: '升级回填', operator: '系统', detail: 'P1-P4回填升级前频率基线；P5缺少历史频率版本，待人工回填后方可判定', createdAt: UPGRADE_AT }
]
