import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test-utils.js';

import NftDetailPage from '../NftDetailPage.js';

const hookMocks = vi.hoisted(() => ({ useNftDetail: vi.fn() }));

vi.mock('../../api/index.js', () => ({
  useNftDetail: hookMocks.useNftDetail,
}));

// The sections below the header carry their own queries.
vi.mock('../nft-detail/NftTransfers.js', () => ({ NftTransfers: () => null }));

describe('NftDetailPage muxed address (task 0649)', () => {
  it('sends a W-address URL to the NFT page of the contract it stands for', () => {
    const c = 'CDL74RF5BLYR2YBLCCI7F5FB6TPSCLKEJUBSD2RSVWZ4YHF3VMFAIGWA';
    const w =
      'WDL74RF5BLYR2YBLCCI7F5FB6TPSCLKEJUBSD2RSVWZ4YHF3VMFAIAAAAAAAAAAAFLR56';
    hookMocks.useNftDetail.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    renderWithProviders(<NftDetailPage />, {
      initialEntries: [`/nfts/${w}/68`],
      routePath: '/nfts/:contractId/:tokenId',
    });
    expect(hookMocks.useNftDetail).toHaveBeenLastCalledWith(c, '68', true);
    expect(hookMocks.useNftDetail).not.toHaveBeenCalledWith(w, '68', true);
  });
});
