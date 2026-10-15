import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Editor } from '@tiptap/core'
import { pageEditorExtensions } from './kit.ts'

const src = "## 示例写法\n\n```md\n:::pageBlock {kind=audit-findings plugin=audit-findings id=cb3cfe89}\n{\n  \"confirmed_by\": \"审计一组\"\n}\n:::\n```\n\n可写字段。\n"

test('dump', () => {
  const editor = new Editor({ extensions: pageEditorExtensions(), content: src, contentType: 'markdown' })
  const json = editor.getJSON()
  editor.destroy()
  assert.equal(JSON.stringify(json, null, 1), 'X')
})
