import { test } from 'vitest'
import assert from 'node:assert/strict'
import { act } from 'react'
import { Context } from 'cordis'
import * as slots from '@biu/web-slots'
import * as appModules from '@biu/web-app-modules'
import * as snapshot from '@biu/web-snapshot'
import * as sessionView from '@biu/web-session-view'
import * as projectView from '@biu/web-project-view'
import * as reactHost from './index.ts'
import * as shell from '@biu/web-app-shell'

test('paints the authentication boundary into el', async () => {
  const el = document.createElement('div')
  const ctx = new Context()
  await ctx.plugin(slots)
  await ctx.plugin(appModules)
  await ctx.plugin(sessionView)
  await ctx.plugin(projectView)
  await ctx.plugin(snapshot)
  await act(async () => {
    await ctx.plugin(reactHost, { el })
    await ctx.plugin(shell)
  })
  // 未登录：落在官网/登录边界，不渲染工作台。
  assert.match(el.innerHTML, /class="site"|auth-gate/)
  assert.doesNotMatch(el.innerHTML, /data-testid="header-config-toggle"/)
})
