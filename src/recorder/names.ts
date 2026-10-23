/** Quoting, identifiers and names shared by the converters. */

export function quote(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}'`;
}

const RESERVED = new Set([
  'default', 'new', 'class', 'function', 'var', 'let', 'const', 'delete', 'in', 'of', 'with', 'switch', 'case', 'if', 'else', 'for', 'while', 'do', 'return', 'import', 'export',
  'this', 'super', 'void', 'typeof', 'instanceof', 'null', 'true', 'false', 'enum', 'interface', 'package', 'static', 'yield', 'await', 'async', 'try', 'catch', 'finally', 'throw',
  'break', 'continue', 'debugger', 'extends', 'implements', 'private', 'protected', 'public',
  // names the generated files use themselves
  'app', 'env', 'test', 'expect', 'data', 'rows', 'path', 'field', 'window', 'dialog', 'CONSTANTS', 'LOCATORS',
]);

/** A name that is safe as a variable / property name in generated code. */
export function identifier(name: string): string {
  return RESERVED.has(name) ? `${name}_` : name;
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** `User ID:` -> `userId`, `RunButton` -> `runButton`. At most `maxWords` words. */
export function camel(text: string, maxWords = 4): string {
  const parts = words(text).slice(0, maxWords);
  const name = parts.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

export function pascal(text: string, maxWords = 6): string {
  const parts = words(text).slice(0, maxWords);
  const name = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** The ending a control's name gets by its UI Automation control type: `OK` (Button) -> `okButton`. */
export const ROLE_SUFFIX: Readonly<Record<string, string>> = {
  Button: 'Button',
  SplitButton: 'Button',
  Edit: 'Field',
  CheckBox: 'Checkbox',
  RadioButton: 'Radio',
  ComboBox: 'Combo',
  List: 'List',
  ListItem: 'Item',
  Tree: 'Tree',
  TreeItem: 'Node',
  Tab: 'Tabs',
  TabItem: 'Tab',
  Table: 'Table',
  DataGrid: 'Grid',
  DataItem: 'Row',
  Menu: 'Menu',
  MenuItem: 'Menu',
  MenuBar: 'MenuBar',
  Document: 'Document',
  Text: 'Text',
  Hyperlink: 'Link',
  Window: 'Window',
  Pane: 'Pane',
  Group: 'Group',
  ToolBar: 'Toolbar',
  StatusBar: 'StatusBar',
  Image: 'Image',
  Spinner: 'Spinner',
  Slider: 'Slider',
  ScrollBar: 'ScrollBar',
};

/** What the items of a container are called in UI Automation. */
export const ITEM_ROLE: Readonly<Record<string, string>> = {
  List: 'ListItem',
  ComboBox: 'ListItem',
  Tree: 'TreeItem',
  Tab: 'TabItem',
  Table: 'DataItem',
  DataGrid: 'DataItem',
};

/** A regular expression source as a case-insensitive literal. The source is checked: a bad pattern throws a SyntaxError at conversion time. */
export function regexLiteral(source: string): string {
  new RegExp(source);
  let out = '';
  let escaped = false;
  for (const ch of source) {
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === '\\') {
      out += ch;
      escaped = true;
    } else if (ch === '/') out += '\\/';
    else if (ch === '\n') out += '\\n';
    else out += ch;
  }
  return `/${out}/i`;
}
