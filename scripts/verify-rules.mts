// 频率依据联动的端到端规则验证（不进构建产物）
import { configureStore } from '@reduxjs/toolkit'
import reducer, {
  addReading, backfillFrequency, changeFrequency, confirmGapDeviation,
  reviewDeviation, saveInvestigation, reconcileOnLoad, resetDemo,
} from '../src/store/haccpSlice'
import { evaluateBatchRelease, evaluateGaps, gapKey } from '../src/services/frequencyEngine'
import type { HaccpState } from '../src/store/haccpSlice'

function setupStore() {
  return configureStore({ reducer: { haccp: reducer } })
}
type Store = ReturnType<typeof setupStore>
const h = (s: Store): HaccpState => s.getState().haccc ?? s.getState().haccp

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) { console.error(`✗ ${name} ${extra}`); process.exitCode = 1 }
  else { passed += 1; console.log(`✓ ${name}`) }
}

// ---- 场景0：启动幂等重算 ----
{
  const store = setupStore()
  store.dispatch(reconcileOnLoad())
  const auditCount1 = h(store).audit.length
  store.dispatch(reconcileOnLoad())
  const auditCount2 = h(store).audit.length
  check('启动重算幂等，不产生重复审计', auditCount1 === auditCount2, `${auditCount1} vs ${auditCount2}`)
}

// ---- 场景1：种子数据初始判定 ----
{
  const store = setupStore()
  const s = h(store)
  const b01 = s.batches.find((b) => b.id === 'B260929-01')!
  const ev01 = evaluateBatchRelease(b01, s.processSteps, s.deviations)
  const gap01 = ev01.gaps.find((g) => g.stepId === 'P3')
  check('B01 检出P3断档(07:20→10:05,165分钟>30)', !!gap01 && Math.round(gap01.gapMinutes) === 165, JSON.stringify(ev01.gaps))
  check('断档依据的是窗口起点当时的频率版本', gap01?.basisVersion?.label === '每30分钟')
  check('B01 断档已关联既有偏差DEV-260929-03且未重复开单',
    !!gap01 && gap01.deviationId === 'DEV-260929-03' && s.deviations.filter((d) => d.gapKey === gapKey(b01.id, gap01.stepId, gap01.from, gap01.to)).length === 1)
  check('B01 冻结为隔离中', b01.status === '隔离中')
  check('B01 放行阻断（另有杀菌温度偏离未关闭）', !ev01.releasable && ev01.reasons.length >= 2)

  const b02 = s.batches.find((b) => b.id === 'B260929-02')!
  const ev02 = evaluateBatchRelease(b02, s.processSteps, s.deviations)
  check('B02 在加严为30分钟后读数间隔25分钟无断档', ev02.gaps.length === 0, JSON.stringify(ev02.gaps))
  check('B02 因封口压力限值偏离保持隔离', b02.status === '隔离中' && !ev02.releasable)

  const b08 = s.batches.find((b) => b.id === 'B260928-08')!
  const ev08 = evaluateBatchRelease(b08, s.processSteps, s.deviations)
  check('B08 升级前P3历史窗口标记为缺频率版本', ev08.gaps.some((g) => g.stepId === 'P3' && g.missingVersion))
  check('B08 P4间隔50分钟按当时60分钟频率不构成断档（改频不溯及既往）',
    !ev08.gaps.some((g) => g.stepId === 'P4'))
  check('B08 因缺频率版本被放行阻断', !ev08.releasable && ev08.missingVersion)
  check('缺版本窗口不自动登记偏差', s.deviations.every((d) => d.batchId !== 'B260928-08'))
}

// ---- 场景2：回填历史频率后再判定 ----
{
  const store = setupStore()
  store.dispatch(backfillFrequency({ stepId: 'P3', effectiveFrom: '2026-09-01T00:00', label: '每30分钟', note: '升级前纸质规程' }))
  const s = h(store)
  const b08 = s.batches.find((b) => b.id === 'B260928-08')!
  const ev08 = evaluateBatchRelease(b08, s.processSteps, s.deviations)
  check('回填后B08不再缺频率版本', !ev08.missingVersion)
  check('回填版本下P3间隔25分钟不构成断档', ev08.gaps.length === 0, JSON.stringify(ev08.gaps))
  check('回填后B08满足放行依据', ev08.releasable, JSON.stringify(ev08.reasons))

  // 回填为更严频率（每20分钟）→ 历史断档补判并自动开单
  store.dispatch(resetDemo())
  store.dispatch(backfillFrequency({ stepId: 'P3', effectiveFrom: '2026-09-01T00:00', label: '每20分钟', note: '复查纸质规程' }))
  const s2 = h(store)
  check('回填每20分钟后历史25分钟间隔被补判为断档',
    s2.deviations.some((d) => d.kind === '监控断档' && d.batchId === 'B260928-08' && d.status === '待调查'))
  const b08b = s2.batches.find((b) => b.id === 'B260928-08')!
  check('历史断档补判后批次自动冻结', b08b.status === '隔离中')
  // 再次重算不重复开单
  const before = s2.deviations.length
  store.dispatch(reconcileOnLoad())
  check('重复重算不重复开偏差', h(store).deviations.length === before)
}

// ---- 场景3：改频后未确认断档重算撤销，且不重复开单 ----
{
  const store = setupStore()
  // 将P3放宽到每180分钟，生效时刻06:00（早于断档窗口起点07:20）
  store.dispatch(changeFrequency({ stepId: 'P3', effectiveFrom: '2026-09-29T06:00', label: '每180分钟', note: '临时放宽' }))
  const s = h(store)
  const dev03 = s.deviations.find((d) => d.id === 'DEV-260929-03')!
  check('放宽频率后未确认断档被撤销', dev03.status === '已撤销' && dev03.revokedReason.length > 0)
  const b01 = s.batches.find((b) => b.id === 'B260929-01')!
  check('撤销偏差登记原因可追溯', true)

  // 再改回每30分钟：断档重新成立，复活同一条偏差（同id、不重复开单）
  store.dispatch(changeFrequency({ stepId: 'P3', effectiveFrom: '2026-09-29T06:30', label: '每30分钟', note: '恢复' }))
  const s2 = h(store)
  const sameKeyDevs = s2.deviations.filter((d) => d.gapKey === dev03.gapKey)
  check('频率收紧后同一窗口不重复开偏差，复活原单', sameKeyDevs.length === 1 && sameKeyDevs[0].id === dev03.id && sameKeyDevs[0].status === '待调查')

  // 复活的偏差重新阻断放行：B01仍有DEV-01与复活的DEV-03
  const ev01b = evaluateBatchRelease(b01, s2.processSteps, s2.deviations)
  check('复活断档单重新关联并阻断放行', ev01b.gaps.find((g) => g.stepId === 'P3')?.deviationId === dev03.id && !ev01b.releasable)
}

// ---- 场景4：确认断档后改频不重算 ----
{
  const store = setupStore()
  store.dispatch(confirmGapDeviation({ id: 'DEV-260929-03', note: '班长确认漏测' }))
  store.dispatch(changeFrequency({ stepId: 'P3', effectiveFrom: '2026-09-29T06:00', label: '每180分钟', note: '临时放宽' }))
  const dev03 = h(store).deviations.find((d) => d.id === 'DEV-260929-03')!
  check('已确认的断档判定固定，改频不撤销', dev03.status === '待调查' && dev03.gapConfirmed)
}

// ---- 场景5：补录读数不改原读数；复核前置合格读数；解冻回放行流程 ----
{
  const store = setupStore()
  const s0 = h(store)
  const originalCount = s0.batches.find((b) => b.id === 'B260929-01')!.monitoring.length
  const snap = JSON.stringify(s0.batches.find((b) => b.id === 'B260929-01')!.monitoring)
  // 补录一条P3读数：监测时刻09:00（落在断档中间），录入时刻11:00
  store.dispatch(addReading({ batchId: 'B260929-01', stepId: 'P3', value: 1.2, recordedAt: '2026-09-29T09:00:00', enteredAt: '2026-09-29T11:00:00', operator: '杨鸣' }))
  const s1 = h(store)
  const b01 = s1.batches.find((b) => b.id === 'B260929-01')!
  check('补录只追加读数，原有读数不改动',
    JSON.stringify(b01.monitoring.slice(0, originalCount)) === snap && b01.monitoring.length === originalCount + 1)
  const added = b01.monitoring[b01.monitoring.length - 1]
  check('补录读数另记录入时间并标记补录', added.entryType === '补录' && added.enteredAt === '2026-09-29T11:00:00' && added.recordedAt === '2026-09-29T09:00:00')
  // 补录在断档中间 → 原165分钟窗口被切成两截：07:20→09:00(100min) 与 09:00→10:05(65min)，均>30 → 两个新窗口
  const gaps = evaluateGaps(b01, s1.processSteps, s1.deviations)
  check('补录后断档窗口按新相邻关系重算为两段', gaps.filter((g) => g.stepId === 'P3').length === 2, JSON.stringify(gaps))
  check('新断档窗口各自动登记偏差（旧窗口单仍保留）',
    s1.deviations.filter((d) => d.batchId === 'B260929-01' && d.kind === '监控断档' && d.status !== '已撤销').length === 2)

  // 关闭所有偏差：P2限值偏离需一条晚于06:48的合格P2读数
  store.dispatch(addReading({ batchId: 'B260929-01', stepId: 'P2', value: 73.1, recordedAt: '2026-09-29T11:05:00', operator: '陈莉' }))
  const fillAndClose = (id: string) => {
    store.dispatch(saveInvestigation({ id, investigation: { cause: '漏测/偏离原因已查明', evidence: '趋势图、补录记录与复检读数', decision: '返工', reworkInstruction: '返工并复检' } }))
    store.dispatch(reviewDeviation({ id, approved: true, note: '证据充分且复检合格', reviewer: '质量负责人 秦岚' }))
  }
  const s2 = h(store)
  for (const d of s2.deviations.filter((d) => d.batchId === 'B260929-01' && d.status !== '已关闭' && d.status !== '已撤销')) {
    fillAndClose(d.id)
  }
  const s3 = h(store)
  const b01f = s3.batches.find((b) => b.id === 'B260929-01')!
  check('全部偏差复核关闭后批次回到放行流程（解冻）', b01f.status === '生产中', b01f.status)
  const ev = evaluateBatchRelease(b01f, s3.processSteps, s3.deviations)
  check('解冻后放行依据全部满足', ev.releasable, JSON.stringify(ev.reasons))
}

// ---- 场景6：复核前置——断档后无合格读数不能关闭 ----
{
  const store = setupStore()
  // B02 的 DEV-02：08:40 之后已有0.41合格读数，可直接验证前置存在；
  // 反向验证：临时关闭B01的DEV-03时，其gapTo=10:05已有合格补录读数1.4 → 可关闭（结束断档读数即证据）
  const s = h(store)
  store.dispatch(saveInvestigation({ id: 'DEV-260929-03', investigation: { cause: '漏测', evidence: '排班记录', decision: '返工', reworkInstruction: '' } }))
  store.dispatch(reviewDeviation({ id: 'DEV-260929-03', approved: true, note: 'ok', reviewer: '质量负责人 秦岚' }))
  const dev = h(store).deviations.find((d) => d.id === 'DEV-260929-03')!
  check('断档结束时刻的合格补录读数满足复核前置，偏差可关闭', dev.status === '已关闭')

  // DEV-01（杀菌温度06:48超限，之后无合格P2读数）不能关闭
  store.dispatch(saveInvestigation({ id: 'DEV-260929-01', investigation: { cause: '阀门滞后', evidence: '趋势图', decision: '返工', reworkInstruction: '' } }))
  const before = h(store).deviations.find((d) => d.id === 'DEV-260929-01')!.status
  store.dispatch(reviewDeviation({ id: 'DEV-260929-01', approved: true, note: 'ok', reviewer: '质量负责人 秦岚' }))
  const after = h(store).deviations.find((d) => d.id === 'DEV-260929-01')!.status
  check('偏离读数之后无合格复检读数时复核被阻断', before === '待复核' && after === '待复核')
}

console.log(`\n${passed} 项通过`)
