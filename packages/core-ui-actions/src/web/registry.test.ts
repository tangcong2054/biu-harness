import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { afterEach, test, vi } from 'vitest'
import { UiActionsService } from './registry.ts'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

test('registered actions are discovered lazily and executed by ref', async () => {
  const service = new UiActionsService(new Context())
  let value = ''
  const dispose = service.register({
    plugin: 'demo',
    instanceId: 'main',
    kind: 'query',
    label: '查询面板',
    surface: 'main',
    state: () => ({ value, password: 'must-not-leak' }),
    actions: {
      fill: {
        description: '填写',
        risk: 'write',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        run: (args) => {
          value = String(args.value)
          return { value, apiKey: 'must-not-leak' }
        },
      },
    },
  })
  const inspected = service.inspect({ plugin: 'demo', includeDom: false }, 'client-1')
  assert.equal(inspected.targets.length, 1)
  assert.equal(inspected.targets[0]?.actions[0]?.id, 'fill')
  assert.equal(inspected.targets[0]?.state?.password, '[redacted]')

  const result = await service.execute({
    ref: inspected.targets[0]!.ref,
    action: 'fill',
    args: { value: 'hello' },
  })
  assert.equal(result.state?.value, 'hello')
  assert.deepEqual(result.result, { value: 'hello', apiKey: '[redacted]' })
  await assert.rejects(
    () => service.execute({ ref: inspected.targets[0]!.ref, action: 'fill', args: {} }),
    /缺少 UI Action 参数/,
  )

  dispose()
  assert.equal(service.inspect({ plugin: 'demo', includeDom: false }, 'client-1').targets.length, 0)
})

test('DOM fallback inspects, fills, and clicks native controls', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 120,
    bottom: 24,
    width: 120,
    height: 24,
    toJSON: () => ({}),
  })
  const root = document.createElement('section')
  root.setAttribute('data-biu-plugin', 'demo-dom')
  const input = document.createElement('input')
  input.setAttribute('data-biu-kind', 'field')
  input.setAttribute('data-biu-id', 'query')
  input.setAttribute('aria-label', '查询词')
  const button = document.createElement('button')
  button.setAttribute('data-biu-kind', 'action')
  button.setAttribute('data-biu-id', 'run')
  button.textContent = '查询'
  let clicked = 0
  button.addEventListener('click', () => { clicked += 1 })
  const password = document.createElement('input')
  password.type = 'password'
  root.append(input, button, password)
  document.body.append(root)

  const service = new UiActionsService(new Context())
  const inspected = service.inspect({ plugin: 'demo-dom' }, 'client-1')
  const inputTarget = inspected.targets.find((target) => target.instanceId === 'query')
  const buttonTarget = inspected.targets.find((target) => target.instanceId === 'run')
  assert.ok(inputTarget?.actions.some((action) => action.id === 'fill'))
  assert.ok(buttonTarget?.actions.some((action) => action.id === 'click'))
  assert.equal(inspected.targets.some((target) => target.label.toLowerCase().includes('password')), false)

  await service.execute({ ref: inputTarget!.ref, action: 'fill', args: { value: 'table1' } })
  await service.execute({ ref: buttonTarget!.ref, action: 'click' })
  assert.equal(input.value, 'table1')
  assert.equal(clicked, 1)
})

test('wait observes registered state changes', async () => {
  const service = new UiActionsService(new Context())
  let done = false
  service.register({
    plugin: 'demo',
    instanceId: 'wait',
    kind: 'status',
    label: '状态',
    state: () => ({ text: done ? '完成' : '执行中' }),
    actions: {},
  })
  const ref = service.inspect({ plugin: 'demo', includeDom: false }, 'client').targets[0]!.ref
  setTimeout(() => { done = true }, 5)
  const result = await service.wait({
    ref,
    condition: 'text-includes',
    value: '完成',
    timeoutMs: 500,
  })
  assert.equal(result.matched, true)
})
