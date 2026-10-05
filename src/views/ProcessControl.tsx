import { useState } from 'react'
import { Badge, Button, Dropdown, Field, Input, Option, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { addFrequencyVersion } from '../store/haccpSlice'
import type { FrequencyMode, ProcessStep } from '../types'
import { formatInterval } from '../services/frequency'

const modeLabel: Record<FrequencyMode, string> = { timed: '定时（按间隔）', perBatch: '每批', continuous: '连续记录' }

function fmt(t: string) {
  return t.replace('T', ' ').slice(0, 16)
}

export function ProcessControl() {
  const dispatch = useDispatch<AppDispatch>()
  const steps = useSelector((root: RootState) => root.haccp.processSteps)
  const versions = useSelector((root: RootState) => root.haccp.frequencyVersions)
  const [changing, setChanging] = useState<ProcessStep | null>(null)
  const [form, setForm] = useState({ mode: 'timed' as FrequencyMode, interval: 60, effectiveFrom: '', note: '' })
  const [backfillStep, setBackfillStep] = useState<ProcessStep | null>(null)
  const [backfill, setBackfill] = useState({ mode: 'perBatch' as FrequencyMode, interval: 60, effectiveFrom: '2026-09-01T00:00', note: '' })

  const openChange = (step: ProcessStep) => {
    const current = versions.filter((v) => v.stepId === step.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
    setChanging(step)
    setForm({
      mode: current?.mode ?? 'timed',
      interval: current?.intervalMinutes ?? 60,
      effectiveFrom: new Date(Date.now() + 3600000).toISOString().slice(0, 16),
      note: ''
    })
  }

  const submitChange = () => {
    if (!changing || !form.effectiveFrom) return
    dispatch(addFrequencyVersion({
      stepId: changing.id,
      mode: form.mode,
      intervalMinutes: form.mode === 'timed' ? form.interval : null,
      effectiveFrom: form.effectiveFrom.length === 16 ? `${form.effectiveFrom}:00` : form.effectiveFrom,
      note: form.note || '控制矩阵改频'
    }))
    setChanging(null)
  }

  const submitBackfill = () => {
    if (!backfillStep || !backfill.effectiveFrom) return
    dispatch(addFrequencyVersion({
      stepId: backfillStep.id,
      mode: backfill.mode,
      intervalMinutes: backfill.mode === 'timed' ? backfill.interval : null,
      effectiveFrom: backfill.effectiveFrom.length === 16 ? `${backfill.effectiveFrom}:00` : backfill.effectiveFrom,
      note: backfill.note || '升级前历史数据缺频率版本，人工回填基线',
      createdBy: '质量主管',
      backfilled: true
    }))
    setBackfillStep(null)
  }

  return (
    <section className="page">
      <header className="page-head"><div><p>危害分析 / 关键控制点</p><h1>HACCP控制矩阵 · 频率依据</h1></div></header>
      <div className="process-flow">{steps.map((step, index) => <div key={step.id}><b>{index + 1}</b><span>{step.name}</span><small>{step.equipment}</small></div>)}</div>
      <div className="table-panel">
        <Table size="small">
          <TableHeader><TableRow><TableHeaderCell>步骤</TableHeaderCell><TableHeaderCell>潜在危害</TableHeaderCell><TableHeaderCell>控制点 / 关键限值</TableHeaderCell><TableHeaderCell>当前监控频率</TableHeaderCell><TableHeaderCell>频率版本链（生效时刻）</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
          <TableBody>{steps.map((step) => {
            const chain = versions.filter((v) => v.stepId === step.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
            return <TableRow key={step.id}>
              <TableCell><strong>{step.name}</strong><br /><small>{step.equipment}</small></TableCell>
              <TableCell>{step.hazard}</TableCell>
              <TableCell>{step.controlPoint}<br /><strong>{step.limit}</strong></TableCell>
              <TableCell>
                <Badge appearance="tint" color="brand">{step.frequency}</Badge>
                {chain.length === 0 && <p className="validation-text" style={{ marginTop: 6 }}>缺频率版本：历史读数无法判定，需先回填</p>}
              </TableCell>
              <TableCell>
                <div className="version-chain">
                  {chain.map((v) => <div key={v.id} className={v.backfilled ? 'version-backfill' : ''}>
                    <time>{fmt(v.effectiveFrom)}</time>
                    <span>{formatInterval(v.intervalMinutes)}</span>
                    {v.backfilled && <Badge size="small" color="warning">历史回填</Badge>}
                    <small title={v.note}>{v.createdBy}</small>
                  </div>)}
                  {chain.length === 0 && <Button size="small" appearance="primary" onClick={() => { setBackfillStep(step); setBackfill((b) => ({ ...b, effectiveFrom: '2026-09-01T00:00' })) }}>回填频率基线</Button>}
                </div>
              </TableCell>
              <TableCell><Button size="small" appearance="subtle" onClick={() => openChange(step)}>改频</Button></TableCell>
            </TableRow>
          })}</TableBody>
        </Table>
      </div>

      {changing && <div className="edit-panel">
        <h3>{changing.name} · 变更监控频率（新版本生效后只影响之后的断档判定）</h3>
        <div className="edit-grid">
          <Field label="频率方式">
            <Dropdown value={modeLabel[form.mode]} selectedOptions={[form.mode]} onOptionSelect={(_, data) => setForm({ ...form, mode: data.optionValue as FrequencyMode })}>
              {Object.entries(modeLabel).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
            </Dropdown>
          </Field>
          {form.mode === 'timed' && <Field label="间隔（分钟）"><Input type="number" value={String(form.interval)} onChange={(_, data) => setForm({ ...form, interval: Number(data.value) })} /></Field>}
          <Field label="生效时刻"><Input type="datetime-local" value={form.effectiveFrom} onChange={(_, data) => setForm({ ...form, effectiveFrom: data.value })} /></Field>
          <Field label="变更依据 / 说明" style={{ gridColumn: '1 / -1' }}><Input value={form.note} onChange={(_, data) => setForm({ ...form, note: data.value })} placeholder="如：设备稳定性验证完成" /></Field>
        </div>
        <div className="record-actions"><Button onClick={() => setChanging(null)}>取消</Button><Button appearance="primary" disabled={form.mode === 'timed' && !(form.interval > 0) || !form.effectiveFrom} onClick={submitChange}>保存新版本并重算断档</Button></div>
      </div>}

      {backfillStep && <div className="edit-panel">
        <h3>{backfillStep.name} · 回填升级前频率基线（先回填，再判定历史读数）</h3>
        <div className="edit-grid">
          <Field label="历史频率方式">
            <Dropdown value={modeLabel[backfill.mode]} selectedOptions={[backfill.mode]} onOptionSelect={(_, data) => setBackfill({ ...backfill, mode: data.optionValue as FrequencyMode })}>
              {Object.entries(modeLabel).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
            </Dropdown>
          </Field>
          {backfill.mode === 'timed' && <Field label="间隔（分钟）"><Input type="number" value={String(backfill.interval)} onChange={(_, data) => setBackfill({ ...backfill, interval: Number(data.value) })} /></Field>}
          <Field label="基线生效时刻（早于历史读数）"><Input type="datetime-local" value={backfill.effectiveFrom} onChange={(_, data) => setBackfill({ ...backfill, effectiveFrom: data.value })} /></Field>
          <Field label="回填说明" style={{ gridColumn: '1 / -1' }}><Input value={backfill.note} onChange={(_, data) => setBackfill({ ...backfill, note: data.value })} placeholder="依据哪份旧版控制计划/SOP" /></Field>
        </div>
        <div className="record-actions"><Button onClick={() => setBackfillStep(null)}>取消</Button><Button appearance="primary" disabled={backfill.mode === 'timed' && !(backfill.interval > 0) || !backfill.effectiveFrom} onClick={submitBackfill}>回填并重算历史断档</Button></div>
      </div>}

      <div className="rule-band"><strong>频率依据约束</strong><span>每个控制点记录监控频率与生效时刻并保留版本；改频新增版本、只影响生效之后；相邻读数间隔超过当时频率即判一段断档，频率一变未确认断档自动重算。</span></div>
    </section>
  )
}
