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
  const inspected = service.inspect({ plugin: 'demo', includeDom: false, includeState: true }, 'client-1')
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

test('inspect defaults to descriptors only and skips DOM when semantic targets exist', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => ({}),
  })
  const button = document.createElement('button')
  button.textContent = 'DOM button'
  document.body.append(button)
  const service = new UiActionsService(new Context())
  service.register({
    plugin: 'demo',
    instanceId: 'semantic',
    kind: 'panel',
    label: 'Semantic',
    state: () => ({ text: 'large state' }),
    actions: {},
  })
  const result = service.inspect({ plugin: 'demo' }, 'client')
  assert.equal(result.targets.length, 1)
  assert.equal(result.targets[0]?.ref.startsWith('ui:'), true)
  assert.equal(result.targets[0]?.state, undefined)
})

test('sensitive containers hide all descendant DOM controls', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => ({}),
  })
  const secret = document.createElement('section')
  secret.setAttribute('data-biu-sensitive', '')
  secret.append(document.createElement('input'), document.createElement('button'))
  document.body.append(secret)
  const service = new UiActionsService(new Context())
  assert.equal(service.inspect({ includeDom: true }, 'client').targets.length, 0)
})

test('batch executes ordered non-destructive actions and rejects destructive ones', async () => {
  const service = new UiActionsService(new Context())
  const values: string[] = []
  service.register({
    plugin: 'demo',
    instanceId: 'batch',
    kind: 'panel',
    label: 'Batch',
    actions: {
      add: {
        description: 'add',
        risk: 'write',
        run: ({ value }) => { values.push(String(value)) },
      },
      remove: {
        description: 'remove',
        risk: 'destructive',
        run: () => { values.pop() },
      },
    },
  })
  const ref = service.inspect({ plugin: 'demo', includeDom: false }, 'client').targets[0]!.ref
  const result = await service.executeBatch({
    ref,
    steps: [
      { action: 'add', args: { value: 'a' } },
      { action: 'add', args: { value: 'b' } },
    ],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(values, ['a', 'b'])
  await assert.rejects(
    () => service.executeBatch({ ref, steps: [{ action: 'remove' }] }),
    /不允许 destructive/,
  )
  assert.deepEqual(values, ['a', 'b'])
})

test('structured wait compares nested state and oversized results are truncated', async () => {
  const service = new UiActionsService(new Context())
  let count = 0
  service.register({
    plugin: 'demo',
    instanceId: 'structured',
    kind: 'status',
    label: 'Structured',
    state: () => ({ count }),
    actions: {
      huge: {
        description: 'huge',
        risk: 'read',
        run: () => Object.fromEntries(
          Array.from({ length: 50 }, (_, index) => [`field${index}`, 'x'.repeat(2000)]),
        ),
      },
    },
  })
  const ref = service.inspect({ plugin: 'demo', includeDom: false }, 'client').targets[0]!.ref
  setTimeout(() => { count = 2 }, 5)
  const waited = await service.wait({
    ref,
    path: 'state.count',
    operator: 'gte',
    value: 2,
    timeoutMs: 500,
  })
  assert.equal(waited.matched, true)
  const result = await service.execute({ ref, action: 'huge' })
  assert.equal(result.truncated, true)
})
