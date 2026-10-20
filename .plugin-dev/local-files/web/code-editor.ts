/** CodeMirror 6 编辑器封装。只依赖沙箱自己的 npm，打进 web.js。 */
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  StreamLanguage,
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { php } from '@codemirror/lang-php'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { extOf } from './kinds.ts'
import { bindSelectionHotkey, type FileSelection } from './selection.ts'

export function languageFor(name: string): Extension {
  const ext = extOf(name)
  if (name.toLowerCase() === 'dockerfile') return StreamLanguage.define(dockerFile)
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ jsx: true, typescript: true })
    case 'json':
    case 'jsonc':
      return json()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'html':
    case 'htm':
    case 'vue':
      return html()
    case 'md':
    case 'markdown':
    case 'mdx':
      return markdown()
    case 'py':
      return python()
    case 'sql':
      return sql()
    case 'yml':
    case 'yaml':
      return yaml()
    case 'xml':
    case 'svg':
      return xml()
    case 'java':
      return java()
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'hpp':
      return cpp()
    case 'go':
      return go()
    case 'rs':
      return rust()
    case 'php':
      return php()
    case 'sh':
    case 'bash':
    case 'zsh':
      return StreamLanguage.define(shell)
    case 'toml':
      return StreamLanguage.define(toml)
    case 'ini':
    case 'conf':
    case 'env':
    case 'properties':
      return StreamLanguage.define(properties)
    case 'lua':
      return StreamLanguage.define(lua)
    case 'rb':
      return StreamLanguage.define(ruby)
    default:
      return []
  }
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: '#fff' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: '1.55',
  },
  '.cm-gutters': { backgroundColor: '#f7f7f8', color: '#9aa0a6', borderRight: '1px solid rgba(15,23,42,.08)' },
  '.cm-activeLine': { backgroundColor: 'rgba(59,130,246,.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(59,130,246,.1)' },
  '&.cm-focused': { outline: 'none' },
})

export type CodeEditorOptions = {
  doc: string
  name: string
  readOnly: boolean
  onChange: (text: string) => void
  onSave: () => void
  onAttach?: (selection: FileSelection | null) => void
  onCursor?: (line: number, col: number) => void
}

export type CodeEditorHandle = {
  setDoc: (text: string) => void
  setReadOnly: (readOnly: boolean) => void
  setName: (name: string) => void
  getDoc: () => string
  focus: () => void
  destroy: () => void
}

export function createCodeEditor(parent: HTMLElement, options: CodeEditorOptions): CodeEditorHandle {
  const language = new Compartment()
  const readOnly = new Compartment()
  let silent = false
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                options.onSave()
                return true
              },
            },
          ]),
        ),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        language.of(languageFor(options.name)),
        readOnly.of([EditorState.readOnly.of(options.readOnly), EditorView.editable.of(!options.readOnly)]),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !silent) options.onChange(update.state.doc.toString())
          if ((update.selectionSet || update.docChanged) && options.onCursor) {
            const head = update.state.selection.main.head
            const line = update.state.doc.lineAt(head)
            options.onCursor(line.number, head - line.from + 1)
          }
        }),
      ],
    }),
  })
  const stopSelectionHotkey = options.onAttach ? bindSelectionHotkey(view, options.onAttach) : () => undefined
  return {
    setDoc(text) {
      if (text === view.state.doc.toString()) return
      silent = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      } finally {
        silent = false
      }
    },
    setReadOnly(value) {
      view.dispatch({ effects: readOnly.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) })
    },
    setName(name) {
      view.dispatch({ effects: language.reconfigure(languageFor(name)) })
    },
    getDoc: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => {
      stopSelectionHotkey()
      view.destroy()
    },
  }
}
