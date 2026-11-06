import { StreamLanguage } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';

const extensionLanguage = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  java: 'java', py: 'python', pyw: 'python', html: 'html', htm: 'html',
  css: 'css', scss: 'css', less: 'css', json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown', rs: 'rust', yml: 'yaml', yaml: 'yaml',
  xml: 'xml', svg: 'xml', xhtml: 'xml', toml: 'toml', ini: 'ini', conf: 'ini',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', go: 'go', php: 'php', sql: 'sql', sh: 'shell', bash: 'shell',
  zsh: 'shell', ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
  dockerfile: 'dockerfile', makefile: 'make', mk: 'make', gradle: 'groovy',
  properties: 'ini', env: 'ini', vue: 'html', svelte: 'html', graphql: 'graphql', gql: 'graphql',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', rb: 'ruby', dart: 'dart', lua: 'lua', ex: 'elixir', exs: 'elixir',
};

const definitions = {
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL',
  cpp: 'alignas alignof and and_eq asm auto bitand bitor bool break case catch char class compl concept const constexpr const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while',
  csharp: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var dynamic get set init record required',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr true false nil',
  php: 'abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public require require_once return static switch throw trait try unset use var while xor yield true false null',
  sql: 'add all alter analyze and any as asc authorization backup between both by cascade case cast check collate column commit constraint create cross current_date current_time database default delete desc distinct drop else end except exists explain false fetch for foreign from full grant group having in index inner insert intersect into is join key left like limit not null offset on or order outer primary procedure references right rollback row select set table then to transaction trigger true truncate union unique update using values view when where with',
  shell: 'if then else elif fi for while until do done case esac function select in time coproc break continue return exit export local readonly declare typeset unset shift source alias unalias cd pwd echo printf read test true false set unset trap wait jobs fg bg kill',
  powershell: 'begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow parallel sequence',
  batch: 'echo @echo off set setlocal endlocal if else for in do call cd chdir dir copy xcopy move del erase mkdir rmdir rd ren rename type start exit pause goto shift pushd popd title color cls rem',
  groovy: 'as assert break case catch class const continue def default do else enum extends false finally for if implements import in instanceof interface new null package private protected public return super switch this throw throws trait true try while',
  graphql: 'query mutation subscription fragment on type input interface union enum scalar schema directive extend implements repeatable true false null',
  toml: 'true false', ini: 'true false yes no on off', xml: 'xml version encoding',
  dockerfile: 'FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL',
  make: 'if ifdef ifndef else endif include define endef override export unexport',
  kotlin: 'abstract actual annotation as break by catch class companion const constructor continue crossinline data delegate do else enum external false field file final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend tailrec this throw true try typealias val var vararg when while',
  swift: 'associatedtype break case catch class continue default defer do else enum extension fallthrough false for func guard if import in init inout internal is let nil open operator private protocol public repeat return self Self static struct subscript super switch throw throws true try typealias var where while',
  ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
  dart: 'abstract as assert async await break case catch class const continue covariant default deferred do else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin native new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield',
  lua: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while',
  elixir: 'after alias and case catch cond def defdelegate defexception defimpl defmacro defmodule defprotocol do else end fn for if import in not or quote raise receive require rescue try unless unquote use when with true false nil',
};

function modeFor(language) {
  const keywords = new Set((definitions[language] || '').split(/\s+/).filter(Boolean));
  const lineComment = ['sql','lua'].includes(language) ? '--' : ['shell','powershell','batch','make','dockerfile','ini','toml','ruby','elixir'].includes(language) ? '#' : '//';
  return StreamLanguage.define({
    startState: () => ({ blockComment: false }),
    token(stream, state) {
      if (stream.eatSpace()) return null;
      if (state.blockComment) { if (stream.match('*/')) state.blockComment = false; else stream.next(); return 'comment'; }
      if (language === 'c' || language === 'cpp' || language === 'csharp' || language === 'java' || language === 'go' || language === 'javascript' || language === 'typescript' || language === 'rust' || language === 'php') {
        if (stream.match('/*')) { state.blockComment = true; return 'comment'; }
      }
      if (stream.match(lineComment)) { stream.skipToEnd(); return 'comment'; }
      if (stream.match(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/)) return 'string';
      if (stream.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:n|f|d)?/i)) return 'number';
      if (stream.match(/^(?:@[\w.]+|\$[\w_]+|\$\{[^}]+\})/)) return 'variableName';
      if (stream.match(/^[\w$][\w$-]*/)) {
        const word = stream.current();
        if (/^(true|false|null|nil|none|undefined|NaN)$/i.test(word)) return 'bool';
        if (keywords.has(word) || keywords.has(word.toLowerCase())) return 'keyword';
        if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) return 'typeName';
        return 'variableName';
      }
      if (stream.match(/^(?:===|!==|=>|->|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|::|\.\.\.)/)) return 'operator';
      if (stream.match(/^[{}()[\],.;:]/)) return 'punctuation';
      if (stream.match(/^[+*%=&|!<>?~^\-/]/)) return 'operator';
      stream.next(); return null;
    },
  });
}

export function detectLanguage(path = '') {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() || '';
  if (name.startsWith('dockerfile')) return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile' || name.startsWith('makefile.')) return 'make';
  return extensionLanguage[name.includes('.') ? name.split('.').pop() : name] || 'plaintext';
}

export function languageExtension(path = '') {
  const language = detectLanguage(path);
  switch (language) {
    case 'javascript': return javascript({ jsx: /\.(jsx|tsx)$/i.test(path) });
    case 'typescript': return javascript({ typescript: true, jsx: path.toLowerCase().endsWith('.tsx') });
    case 'java': return java();
    case 'python': return python();
    case 'html': return html();
    case 'css': return css();
    case 'json': return json();
    case 'markdown': return markdown();
    case 'rust': return rust();
    case 'yaml': return yaml();
    case 'plaintext': return [];
    default: return modeFor(language);
  }
}
