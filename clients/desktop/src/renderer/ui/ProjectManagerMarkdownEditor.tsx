import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import Placeholder from "@tiptap/extension-placeholder";

type ToolbarState = {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  heading: 0 | 1 | 2 | 3;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  blockquote: boolean;
  codeBlock: boolean;
  link: boolean;
  table: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

function toolbarState(editor: Editor): ToolbarState {
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    heading: ([1, 2, 3] as const).find((level) => editor.isActive("heading", { level })) ?? 0,
    bulletList: editor.isActive("bulletList"),
    orderedList: editor.isActive("orderedList"),
    taskList: editor.isActive("taskList"),
    blockquote: editor.isActive("blockquote"),
    codeBlock: editor.isActive("codeBlock"),
    link: editor.isActive("link"),
    table: editor.isActive("table"),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
  };
}

/// A Markdown document editor for a ticket description: headings, lists,
/// task lists, quotes, code, links, and tables, with a formatting toolbar and
/// Markdown shortcuts. It reports Markdown only for the user's own edits;
/// `resetKey` replaces its content with `value` (a newer saved version).
export function ProjectManagerMarkdownEditor(props: {
  value: string;
  resetKey: string;
  disabled: boolean;
  placeholder: string;
  label: string;
  onChange(markdown: string): void;
  /// The editor's own Markdown for `value`, so an untouched description is
  /// never mistaken for an edit.
  onBaseline(markdown: string): void;
}) {
  const onChange = useRef(props.onChange);
  const onBaseline = useRef(props.onBaseline);
  onChange.current = props.onChange;
  onBaseline.current = props.onBaseline;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: "https" } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder: props.placeholder }),
      Markdown,
    ],
    content: props.value,
    contentType: "markdown",
    editable: !props.disabled,
    editorProps: { attributes: { class: "pm-md", "aria-label": props.label, role: "textbox", "aria-multiline": "true" } },
    onCreate: ({ editor: created }) => onBaseline.current(created.getMarkdown()),
    onUpdate: ({ editor: updated }) => onChange.current(updated.getMarkdown()),
  });
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setContent(props.value, { contentType: "markdown", emitUpdate: false });
    onBaseline.current(editor.getMarkdown());
    // Only a new saved version replaces what the user sees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, props.resetKey]);
  useEffect(() => { editor?.setEditable(!props.disabled); }, [editor, props.disabled]);
  const state = useEditorState({ editor, selector: ({ editor: current }) => current ? toolbarState(current) : null });

  const run = (action: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
    if (editor) action(editor.chain().focus()).run();
  };
  // Electron has no window.prompt; the link address is typed in a bar.
  const [linkDraft, setLinkDraft] = useState<string>();
  const setLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    setLinkDraft("https://");
  };
  const applyLink = () => {
    const href = linkDraft?.trim();
    setLinkDraft(undefined);
    if (editor && href && href !== "https://") {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
  };
  const tool = (label: string, glyph: string, active: boolean, action: () => void, disabled = false) => <button
    type="button"
    className={`pm-tool${active ? " active" : ""}`}
    title={label}
    aria-label={label}
    aria-pressed={active}
    disabled={props.disabled || disabled}
    onMouseDown={(event) => event.preventDefault()}
    onClick={action}
  >{glyph}</button>;

  return <div className={`pm-editor${props.disabled ? " disabled" : ""}`}>
    {state ? <div className="pm-toolbar" role="toolbar" aria-label="Formatting">
      <select
        className="pm-tool-block"
        aria-label="Text style"
        disabled={props.disabled}
        value={state.heading}
        onChange={(event) => {
          const level = Number(event.target.value) as 0 | 1 | 2 | 3;
          run((chain) => level === 0 ? chain.setParagraph() : chain.setHeading({ level }));
        }}
      >
        <option value={0}>Text</option>
        <option value={1}>Heading 1</option>
        <option value={2}>Heading 2</option>
        <option value={3}>Heading 3</option>
      </select>
      <span className="pm-tool-sep" />
      {tool("Bold", "B", state.bold, () => run((chain) => chain.toggleBold()))}
      {tool("Italic", "I", state.italic, () => run((chain) => chain.toggleItalic()))}
      {tool("Strikethrough", "S", state.strike, () => run((chain) => chain.toggleStrike()))}
      {tool("Inline code", "</>", state.code, () => run((chain) => chain.toggleCode()))}
      {tool(state.link ? "Remove link" : "Link", "🔗", state.link, setLink)}
      <span className="pm-tool-sep" />
      {tool("Bulleted list", "•", state.bulletList, () => run((chain) => chain.toggleBulletList()))}
      {tool("Numbered list", "1.", state.orderedList, () => run((chain) => chain.toggleOrderedList()))}
      {tool("Checklist", "☑", state.taskList, () => run((chain) => chain.toggleTaskList()))}
      {tool("Quote", "❝", state.blockquote, () => run((chain) => chain.toggleBlockquote()))}
      {tool("Code block", "{ }", state.codeBlock, () => run((chain) => chain.toggleCodeBlock()))}
      {state.table
        ? <>
          {tool("Add row", "+row", false, () => run((chain) => chain.addRowAfter()))}
          {tool("Add column", "+col", false, () => run((chain) => chain.addColumnAfter()))}
          {tool("Delete table", "×tbl", false, () => run((chain) => chain.deleteTable()))}
        </>
        : tool("Table", "▦", false, () => run((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true })))}
      {tool("Divider", "—", false, () => run((chain) => chain.setHorizontalRule()))}
      <span className="pm-tool-grow" />
      {tool("Undo", "↶", false, () => run((chain) => chain.undo()), !state.canUndo)}
      {tool("Redo", "↷", false, () => run((chain) => chain.redo()), !state.canRedo)}
    </div> : null}
    {linkDraft !== undefined ? <form className="pm-link-bar" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
      <input
        aria-label="Link address"
        autoFocus
        value={linkDraft}
        onChange={(event) => setLinkDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setLinkDraft(undefined); } }}
      />
      <button type="submit" className="td-mini">Apply</button>
      <button type="button" className="td-mini" onClick={() => setLinkDraft(undefined)}>Cancel</button>
    </form> : null}
    <EditorContent editor={editor} className="pm-editor-content" />
  </div>;
}
