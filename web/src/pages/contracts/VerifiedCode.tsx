import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Alert,
  Box,
  Button,
  Collapse,
  Link,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  CardSkeleton,
  Chip,
  CopyButton,
  QueryErrorState,
  RelativeTimestamp,
} from '@rumblefish/soroban-block-explorer-ui';
import { useState, type ReactNode } from 'react';

import { useContractVerifiedSource } from '../../api/index.js';
import { DisclosureRow } from '../transaction-detail/shared/DisclosureRow.js';

import { SourceBrowser } from './SourceBrowser.js';

import type {
  BuildRecipe,
  SourceVerificationResponse,
  VerifiedSourceFile,
} from '@rumblefish/api-types';

const BLOCKSMITH_URL = 'https://staging.sv.blocksmith.co/api/query/v1/docs';

/** The two states the tab exists for; everything else shows nothing. */
export function isShownVerification(
  v: SourceVerificationResponse | undefined
): v is SourceVerificationResponse {
  return v?.status === 'verified' || v?.status === 'verified_private';
}

/** Third-party URLs become links only over http(s) — never `javascript:`. */
const safeHref = (url: string | null | undefined): string | undefined =>
  url != null && /^https?:\/\//i.test(url) ? url : undefined;

const verifierNames = (v: SourceVerificationResponse): string[] => [
  ...new Set(v.verifiers.map((x) => x.name ?? x.url)),
];

const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

/** Same line, typography and colour as "WASM decompilation provided by Inferara". */
function Attribution({
  verification,
}: {
  verification: SourceVerificationResponse;
}) {
  const names = verifierNames(verification);
  if (names.length === 0) return null;
  return (
    <Typography
      variant="bodyXsRegular"
      sx={(theme) => ({ color: theme.palette.text.tertiary })}
    >
      Source verification by {names.join(', ')} · aggregated by{' '}
      <Link
        href={BLOCKSMITH_URL}
        target="_blank"
        rel="noopener noreferrer"
        color="inherit"
      >
        BlockSmith
      </Link>
    </Typography>
  );
}

function Toolbar({
  verification,
}: {
  verification: SourceVerificationResponse;
}) {
  const { build, source } = verification;
  const download = safeHref(source?.url);
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ flexWrap: 'wrap', rowGap: 1 }}
    >
      <Chip size="sm" color="emerald" label="Verified" />
      {verifierNames(verification).map((n) => (
        <Chip key={n} size="sm" color="neutral" label={n} />
      ))}
      {build?.package != null && (
        <Tooltip
          title={
            build.manifest_path ? `Cargo manifest: ${build.manifest_path}` : ''
          }
          arrow
        >
          <Chip size="sm" color="neutral" label={`package ${build.package}`} />
        </Tooltip>
      )}
      <Box sx={{ flexGrow: 1 }} />
      {download != null && source != null && (
        <Button
          size="small"
          color="inherit"
          startIcon={<FileDownloadOutlinedIcon />}
          href={download}
          rel="noopener noreferrer"
        >
          Download source .{source.format}
        </Button>
      )}
    </Stack>
  );
}

/** The recipe to reproduce the build, in the Decompilation tab's
 *  "Binary features" box, collapsed behind the same chevron as the tree. */
function BuildRecipeBox({
  build,
  sha256,
}: {
  build: BuildRecipe;
  sha256: string;
}) {
  const [open, setOpen] = useState(false);
  const rows: [string, ReactNode, string | null][] = [
    [
      'Verified',
      build.verified_at != null ? (
        <RelativeTimestamp timestamp={build.verified_at} />
      ) : (
        '—'
      ),
      null,
    ],
    ['Cargo manifest', build.manifest_path ?? '— (workspace root)', null],
    ['Build image', build.image ?? '—', build.image ?? null],
    [
      'Build options',
      build.options.join(' ') || '—',
      build.options.join(' ') || null,
    ],
    [
      'Build arguments',
      build.arguments.join(' ') || 'contract build (default)',
      null,
    ],
    ['Source archive sha256', sha256, sha256],
  ];
  const report = safeHref(build.report_url);
  return (
    <Stack
      spacing={1}
      sx={(theme) => ({
        p: 1.5,
        borderRadius: `${theme.shape.radius.s}px`,
        border: `1px solid ${theme.palette.stroke.default}`,
      })}
    >
      <DisclosureRow
        open={open}
        onToggle={() => setOpen((o) => !o)}
        label="Build recipe"
      />
      <Collapse in={open} unmountOnExit>
        <Stack spacing={0.75}>
          {rows.map(([k, val, copy]) => (
            <Stack
              key={k}
              direction={{ xs: 'column', sm: 'row' }}
              spacing={{ xs: 0.25, sm: 1 }}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
            >
              <Typography
                variant="bodyXsMedium"
                sx={(theme) => ({
                  color: theme.palette.text.secondary,
                  minWidth: { sm: 150 },
                  flexShrink: 0,
                })}
              >
                {k}
              </Typography>
              <Stack
                direction="row"
                spacing={0.5}
                alignItems="center"
                sx={{ minWidth: 0 }}
              >
                <Typography
                  variant="bodyXsRegular"
                  component="span"
                  sx={(theme) => ({
                    color: theme.palette.text.tertiary,
                    fontFamily: 'monospace',
                    wordBreak: 'break-all',
                  })}
                >
                  {val}
                </Typography>
                {copy != null && (
                  <CopyButton value={copy} ariaLabel={`Copy ${k}`} />
                )}
              </Stack>
            </Stack>
          ))}
          {report != null && (
            <Typography variant="bodyXsRegular">
              <Link
                href={report}
                target="_blank"
                rel="noopener noreferrer"
                color="inherit"
              >
                Full verification report (JSON)
              </Link>
            </Typography>
          )}
        </Stack>
      </Collapse>
    </Stack>
  );
}

function StatsLine({ files }: { files: VerifiedSourceFile[] }) {
  const bytes = files.reduce((s, f) => s + f.size, 0);
  const size =
    bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
  return (
    <Typography
      variant="bodyXsRegular"
      sx={(theme) => ({ color: theme.palette.text.tertiary })}
    >
      {files.length} files · {size} unpacked · archive integrity checked
    </Typography>
  );
}

function PublishedSource({
  contractId,
  verification,
}: {
  contractId: string;
  verification: SourceVerificationResponse;
}) {
  const { data, isPending, isError, error, refetch } =
    useContractVerifiedSource(contractId);
  if (isPending) return <CardSkeleton />;
  if (isError || data == null) {
    return <QueryErrorState error={error} onRetry={() => void refetch()} />;
  }
  return (
    <>
      <StatsLine files={data.files} />
      {verification.build != null && (
        <BuildRecipeBox
          build={verification.build}
          sha256={data.archive_sha256}
        />
      )}
      <SourceBrowser
        files={data.files}
        manifestPath={verification.build?.manifest_path}
      />
    </>
  );
}

/**
 * Verified Code tab (task 0639): source code an independent verifier
 * rebuilt to the exact on-chain WASM, read through the BlockSmith Query
 * API. Built from the Decompilation tab's parts (`ContractCode.tsx`): chip
 * toolbar with Download on the right, one Alert, a stats line, a bordered
 * details box, `CodeHighlight` with `CopyButton`, the attribution line.
 *
 * Mounted only for `verified` and `verified_private` — results that did not
 * reproduce the on-chain code show nothing anywhere.
 */
export function VerifiedCode({
  contractId,
  verification,
}: {
  contractId: string;
  verification: SourceVerificationResponse;
}) {
  const names = verifierNames(verification).join(', ');
  return (
    <Stack spacing={1.5} sx={{ p: 2 }}>
      <Toolbar verification={verification} />
      {verification.status === 'verified' ? (
        <>
          <Alert
            severity="success"
            icon={<InfoOutlinedIcon fontSize="small" />}
          >
            Verified source — rebuilding this source reproduces the on-chain
            WASM <code>{shortHash(verification.wasm_hash)}</code> byte for byte.
          </Alert>
          <PublishedSource
            contractId={contractId}
            verification={verification}
          />
        </>
      ) : (
        <Alert severity="success" icon={<InfoOutlinedIcon fontSize="small" />}>
          Verified by {names} — the source code is not published.
        </Alert>
      )}
      <Attribution verification={verification} />
    </Stack>
  );
}
