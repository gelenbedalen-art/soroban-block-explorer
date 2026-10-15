import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import { Box, Collapse, Stack, Typography, useMediaQuery } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  CopyButton,
  DebouncedField,
  EmptyState,
} from '@rumblefish/soroban-block-explorer-ui';
import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { DisclosureRow } from '../transaction-detail/shared/DisclosureRow.js';

import type { CodeLanguage } from './CodeHighlight.js';
import type { VerifiedSourceFile } from '@rumblefish/api-types';
import type { Theme } from '@mui/material/styles';

// Prism (and its grammars) load in their own chunk, as on the Decompilation tab.
const CodeHighlight = lazy(() => import('./CodeHighlight.js'));

/** Tree and code share one height per archive: the taller of the opening
 *  tree and the longest file, capped like the Decompilation viewer — so
 *  switching files never moves the page. */
const MAX_HEIGHT = 640;
const PATH_BAR = 36;
const FILTER_BAR = 56;
const ROW = 26;
const LINE = 21;
const CODE_PAD = 16 * 2 + 2;

export function languageOf(path: string): CodeLanguage {
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.toml') || path.endsWith('.lock')) return 'toml';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('Makefile')) return 'makefile';
  return 'none';
}

type Node = {
  name: string;
  path: string;
  children: Node[];
  file?: VerifiedSourceFile;
};

/** Folders first, then files, each alphabetical. */
export function buildTree(files: VerifiedSourceFile[]): Node {
  const root: Node = { name: '', path: '', children: [] };
  for (const f of files) {
    let cur = root;
    const parts = f.path.split('/');
    parts.forEach((part, i) => {
      let next = cur.children.find((c) => c.name === part);
      if (!next) {
        next = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: [],
        };
        cur.children.push(next);
      }
      if (i === parts.length - 1) next.file = f;
      cur = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => {
      const af = a.file != null;
      const bf = b.file != null;
      if (af !== bf) return af ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** The file to open first: the built package's `src/lib.rs` (one archive
 *  can hold several contracts), then any `src/lib.rs`, any `.rs`, the first. */
export function defaultFile(
  files: VerifiedSourceFile[],
  manifestPath: string | null | undefined
): VerifiedSourceFile | undefined {
  const dir = manifestPath?.replace(/\/?Cargo\.toml$/, '');
  if (dir) {
    const built = files.find((f) => f.path.endsWith(`${dir}/src/lib.rs`));
    if (built) return built;
  }
  const lib = files.find((f) => f.path.endsWith('src/lib.rs'));
  if (lib) return lib;
  const rust = files.find((f) => f.path.endsWith('.rs'));
  if (rust) return rust;
  return files[0];
}

const countRows = (n: Node, selected: string): number =>
  n.children.reduce((sum, c) => {
    const open = selected === c.path || selected.startsWith(`${c.path}/`);
    return sum + 1 + (c.file == null && open ? countRows(c, selected) : 0);
  }, 0);

const boxSx = (theme: Theme) => ({
  borderRadius: `${theme.shape.radius.s}px`,
  border: `1px solid ${theme.palette.stroke.default}`,
  backgroundColor: theme.palette.surface.grayMainAlt,
});

/** Arrow keys over the visible rows (WAI-ARIA tree pattern): Up/Down move,
 *  Right opens a folder, Left closes it, Enter/Space activates. */
function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role=treeitem]'),
  ];
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const row = rows[i];
  if (row == null) return;
  const isFolder = row.dataset['folder'] === 'true';
  const isOpen = row.getAttribute('aria-expanded') === 'true';
  const focus = (j: number) =>
    rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
  switch (event.key) {
    case 'ArrowDown':
      focus(i + 1);
      break;
    case 'ArrowUp':
      focus(i - 1);
      break;
    case 'Home':
      focus(0);
      break;
    case 'End':
      focus(rows.length - 1);
      break;
    case 'ArrowRight':
      if (isFolder && !isOpen) row.click();
      else if (isFolder) focus(i + 1);
      break;
    case 'ArrowLeft':
      if (isFolder && isOpen) {
        row.click();
      } else {
        // On a file or a closed folder: up to the folder that holds it.
        const parent =
          row.parentElement?.closest('[role=group]')?.previousElementSibling;
        if (parent instanceof HTMLElement) parent.focus();
      }
      break;
    case 'Enter':
    case ' ':
      row.click();
      break;
    default:
      return;
  }
  event.preventDefault();
}

/** One `treeitem`. Only the open file is a tab stop (roving tabindex);
 *  selection uses the code viewer's own line highlight. */
function TreeRow({
  node,
  depth,
  selected,
  onPick,
  forceOpen,
}: {
  node: Node;
  depth: number;
  selected: string;
  onPick: (path: string) => void;
  forceOpen: boolean;
}) {
  const onPath = selected === node.path || selected.startsWith(`${node.path}/`);
  const [open, setOpen] = useState(onPath);
  const ref = useRef<HTMLDivElement>(null);
  const isSel = node.file != null && selected === node.path;
  useEffect(() => {
    // Scroll the tree only — scrollIntoView would scroll the whole page.
    const row = ref.current;
    const box = row?.closest('[role=tree]') as HTMLElement | null;
    if (!isSel || row == null || box == null) return;
    const top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) {
      box.scrollTop = top - box.clientHeight / 2;
    }
  }, [isSel]);
  const expanded = forceOpen || open;
  const iconSx = (theme: Theme) => ({
    flexShrink: 0,
    color: theme.palette.text.tertiary,
  });
  return (
    <>
      <Box
        ref={ref}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={node.file ? undefined : expanded}
        aria-selected={node.file ? isSel : undefined}
        data-folder={node.file ? undefined : 'true'}
        tabIndex={isSel ? 0 : -1}
        onClick={() => (node.file ? onPick(node.path) : setOpen((o) => !o))}
        sx={(theme) => ({
          pl: 0.5 + depth * 1.5,
          pr: 1,
          py: 0.25,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: 13,
          lineHeight: '22px',
          whiteSpace: 'nowrap',
          color: isSel
            ? theme.palette.text.primary
            : theme.palette.text.secondary,
          fontWeight: node.file ? 400 : 600,
          backgroundColor: isSel
            ? alpha(theme.palette.text.accent, 0.14)
            : 'transparent',
          '&:hover': {
            color: theme.palette.text.primary,
            backgroundColor: isSel
              ? alpha(theme.palette.text.accent, 0.14)
              : theme.palette.surface.grayHover,
          },
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.text.accent}`,
            outlineOffset: -2,
          },
        })}
      >
        <Box
          component="span"
          sx={{ display: 'inline-flex', width: 18, flexShrink: 0 }}
        >
          {!node.file && (
            <KeyboardArrowRightIcon
              sx={{
                fontSize: 18,
                transform: expanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 120ms ease',
              }}
            />
          )}
        </Box>
        {node.file ? (
          <InsertDriveFileOutlinedIcon
            sx={(t) => ({ ...iconSx(t), fontSize: 15 })}
          />
        ) : (
          <FolderOutlinedIcon sx={(t) => ({ ...iconSx(t), fontSize: 16 })} />
        )}
        <Box
          component="span"
          sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {node.name}
        </Box>
      </Box>
      {!node.file && expanded && (
        <Box role="group">
          {node.children.map((c) => (
            <TreeRow
              key={c.path}
              node={c}
              depth={depth + 1}
              selected={selected}
              onPick={onPick}
              forceOpen={forceOpen}
            />
          ))}
        </Box>
      )}
    </>
  );
}

/**
 * File tree beside the code viewer for a verified source archive (task
 * 0639). The open file lives in the URL (`?file=`), like tabs and table
 * state, so a link can point at one file.
 */
export function SourceBrowser({
  files,
  manifestPath,
}: {
  files: VerifiedSourceFile[];
  manifestPath: string | null | undefined;
}) {
  const [params, setParams] = useSearchParams();
  const first = useMemo(
    () => defaultFile(files, manifestPath),
    [files, manifestPath]
  );
  const file = files.find((f) => f.path === params.get('file')) ?? first;
  const [filter, setFilter] = useState('');
  const codeRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  // Roving tabindex: the open file is the tree's one tab stop. When the
  // filter or a closed folder hides it, the first visible row takes over, so
  // Tab never skips the tree.
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (tree == null || tree.querySelector('[role=treeitem][tabindex="0"]'))
      return;
    tree
      .querySelector<HTMLElement>('[role=treeitem]')
      ?.setAttribute('tabindex', '0');
  });
  const shown = useMemo(
    () =>
      files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())),
    [files, filter]
  );
  const tree = useMemo(() => buildTree(shown), [shown]);
  const height = useMemo(() => {
    const opening =
      FILTER_BAR + countRows(buildTree(files), first?.path ?? '') * ROW + 8;
    const longest = Math.max(
      0,
      ...files.map((f) => (f.content ?? '').split('\n').length)
    );
    return Math.min(
      MAX_HEIGHT,
      Math.max(opening, PATH_BAR + longest * LINE + CODE_PAD)
    );
  }, [files, first]);

  // On a phone a scrollable tree in mid-page catches the swipe meant for the
  // page, so it starts folded under "Files (N)" and the code comes first.
  const belowMd = useMediaQuery(useTheme().breakpoints.down('md'));
  const [filesOpen, setFilesOpen] = useState(false);

  const pick = (path: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('file', path);
        return next;
      },
      { replace: true }
    );
    // On a phone the tree sits above the code: fold it away and bring the
    // code into view.
    if (belowMd) {
      setFilesOpen(false);
      codeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  if (file == null) {
    return (
      <EmptyState
        icon={<InfoOutlinedIcon fontSize="small" />}
        title="The verified source archive holds no files"
      />
    );
  }

  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={1.5}
      alignItems="stretch"
    >
      {belowMd && (
        <DisclosureRow
          open={filesOpen}
          onToggle={() => setFilesOpen((o) => !o)}
          label={`Files (${files.length})`}
        />
      )}
      <Collapse in={!belowMd || filesOpen} unmountOnExit={belowMd}>
        <Box
          sx={(theme) => ({
            ...boxSx(theme),
            width: { md: 280 },
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            height: { xs: 260, md: height },
          })}
        >
          <Box
            sx={(theme) => ({
              p: 1,
              borderBottom: `1px solid ${theme.palette.stroke.default}`,
              flexShrink: 0,
            })}
          >
            <DebouncedField
              value={filter}
              placeholder={`Filter ${files.length} files`}
              ariaLabel="Filter source files"
              width="100%"
              onCommit={setFilter}
            />
          </Box>
          <Box
            ref={treeRef}
            role="tree"
            aria-label="Source files"
            onKeyDown={onTreeKeyDown}
            sx={{ overflow: 'auto', py: 0.5, flexGrow: 1 }}
          >
            {shown.length === 0 ? (
              <EmptyState
                icon={<InfoOutlinedIcon fontSize="small" />}
                title="No files match"
                py={2}
              />
            ) : (
              tree.children.map((c) => (
                <TreeRow
                  key={c.path}
                  node={c}
                  depth={0}
                  selected={file.path}
                  onPick={pick}
                  forceOpen={filter.length > 0}
                />
              ))
            )}
          </Box>
        </Box>
      </Collapse>
      <Stack ref={codeRef} sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography
          variant="bodyXsMedium"
          sx={(theme) => ({
            color: theme.palette.text.secondary,
            fontFamily: 'monospace',
            height: PATH_BAR,
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          {file.path}
        </Typography>
        {file.content == null ? (
          <EmptyState
            icon={<InfoOutlinedIcon fontSize="small" />}
            title="Not a text file"
            description={`${file.size.toLocaleString(
              'en-US'
            )} bytes — download the archive to inspect it.`}
          />
        ) : (
          <Box sx={{ position: 'relative' }}>
            <Box sx={{ position: 'absolute', top: 8, right: 12, zIndex: 2 }}>
              <CopyButton value={file.content} ariaLabel="Copy file" />
            </Box>
            <Suspense
              fallback={
                // Same as the Decompilation tab: the text first, colours later.
                <Box
                  component="pre"
                  sx={(theme) => ({
                    ...boxSx(theme),
                    m: 0,
                    p: 2,
                    overflow: 'auto',
                    height: height - PATH_BAR,
                    fontFamily: 'monospace',
                    fontSize: 13,
                    lineHeight: '21px',
                  })}
                >
                  {file.content}
                </Box>
              }
            >
              <CodeHighlight
                key={file.path}
                source={file.content}
                language={languageOf(file.path)}
                height={height - PATH_BAR}
              />
            </Suspense>
          </Box>
        )}
      </Stack>
    </Stack>
  );
}
