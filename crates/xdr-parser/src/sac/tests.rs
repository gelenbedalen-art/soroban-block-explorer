use super::*;

/// Mainnet network_id is a well-known hex string; drift in SHA2 or
/// passphrase definition would be caught here before anything else
/// misbehaves.
#[test]
fn mainnet_network_id_matches_known_hex() {
    assert_eq!(
        hex::encode(network_id(MAINNET_PASSPHRASE)),
        "7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979"
    );
}

#[test]
fn testnet_network_id_matches_known_hex() {
    assert_eq!(
        hex::encode(network_id(TESTNET_PASSPHRASE)),
        "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472"
    );
}

#[test]
fn passphrase_lookup_accepts_common_aliases() {
    assert_eq!(passphrase_for("mainnet"), Some(MAINNET_PASSPHRASE));
    assert_eq!(passphrase_for("MAINNET"), Some(MAINNET_PASSPHRASE));
    assert_eq!(passphrase_for("public"), Some(MAINNET_PASSPHRASE));
    assert_eq!(passphrase_for("testnet"), Some(TESTNET_PASSPHRASE));
    assert_eq!(passphrase_for("bogus"), None);
}

/// XLM-SAC on mainnet is a published constant across the Stellar
/// ecosystem (Horizon, SDK, Stellar Expert). Regression-guards the
/// derivation against any change in XDR layout or hashing inputs.
#[test]
fn xlm_sac_mainnet_contract_id() {
    let net = network_id(MAINNET_PASSPHRASE);
    let preimage = ContractIdPreimage::Asset(Asset::Native);
    let cid = derive_sac_contract_id(&preimage, &net).unwrap();
    assert_eq!(
        cid,
        "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
    );
}

/// Circle USDC mainnet SAC: issuer `GA5ZSEJY...KZVN`, code `USDC`.
#[test]
fn usdc_sac_mainnet_contract_id() {
    use core::str::FromStr;
    let issuer =
        AccountId::from_str("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN").unwrap();
    let asset = Asset::CreditAlphanum4(AlphaNum4 {
        asset_code: AssetCode4(*b"USDC"),
        issuer,
    });

    let net = network_id(MAINNET_PASSPHRASE);
    let preimage = ContractIdPreimage::Asset(asset);
    let cid = derive_sac_contract_id(&preimage, &net).unwrap();
    assert_eq!(
        cid,
        "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
    );
}

// -- Factory SAC: CreateContractHostFn carried inside auth entries --

use stellar_xdr::{
    ContractExecutable, InvokeContractArgs, InvokeHostFunctionOp, Memo, MuxedAccount, Operation,
    Preconditions, ScSymbol, SequenceNumber, SorobanAuthorizationEntry, SorobanCredentials,
    Transaction, TransactionExt, Uint256, VecM,
};

/// Build a single-operation V1 transaction whose only operation is an
/// InvokeHostFunction call to a factory contract with the supplied
/// auth-entry root invocation. Surface mirrors `invocation::tests::build_v1_tx`.
fn build_factory_tx(root_invocation: SorobanAuthorizedInvocation) -> Transaction {
    let factory_call = HostFunction::InvokeContract(InvokeContractArgs {
        contract_address: ScAddress::Contract(ContractId(Hash([0xFA; 32]))),
        function_name: ScSymbol::try_from(b"deploy_pair".to_vec()).unwrap(),
        args: VecM::default(),
    });
    let auth = SorobanAuthorizationEntry {
        credentials: SorobanCredentials::SourceAccount,
        root_invocation,
    };
    let op = Operation {
        source_account: None,
        body: OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
            host_function: factory_call,
            auth: vec![auth].try_into().unwrap(),
        }),
    };
    Transaction {
        source_account: MuxedAccount::Ed25519(Uint256([0xAA; 32])),
        fee: 100,
        seq_num: SequenceNumber(1),
        cond: Preconditions::None,
        memo: Memo::None,
        operations: vec![op].try_into().unwrap(),
        ext: TransactionExt::V0,
    }
}

fn create_contract_host_fn_node(asset: Asset) -> SorobanAuthorizedInvocation {
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::CreateContractHostFn(CreateContractArgs {
            contract_id_preimage: ContractIdPreimage::Asset(asset),
            executable: ContractExecutable::StellarAsset,
        }),
        sub_invocations: VecM::default(),
    }
}

/// Top-level factory pattern: auth entry's root invocation IS the
/// CreateContractHostFn. Stellar SDK / soroban-cli emits this shape
/// for direct sac-wrap invocations.
#[test]
fn extract_sac_identities_from_auth_entry_root_create_contract() {
    let tx = build_factory_tx(create_contract_host_fn_node(Asset::Native));
    let inner = InnerTxRef::V1(&tx);

    let net = network_id(MAINNET_PASSPHRASE);
    let pairs = extract_sac_identities(&inner, &net);

    assert_eq!(
        pairs.len(),
        1,
        "auth-entry root CreateContractHostFn picked up"
    );
    assert_eq!(pairs[0].1, SacAssetIdentity::Native);
    assert_eq!(
        pairs[0].0, "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
        "deterministic XLM-SAC contract_id derived even when the \
         CreateContractHostFn lives in auth, not in a top-level operation"
    );
}

/// Deep factory pattern: the auth entry's root is a regular ContractFn
/// (the factory's `deploy_pair` entrypoint), with the actual
/// CreateContractHostFn nested as a sub_invocation. Mirrors how LP /
/// AMM factories surface their child SAC deploys.
#[test]
fn extract_sac_identities_from_nested_auth_sub_invocation() {
    use core::str::FromStr;
    let issuer =
        AccountId::from_str("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN").unwrap();
    let usdc = Asset::CreditAlphanum4(AlphaNum4 {
        asset_code: AssetCode4(*b"USDC"),
        issuer,
    });
    let nested_create = create_contract_host_fn_node(usdc);

    let factory_root = SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: ScAddress::Contract(ContractId(Hash([0xFA; 32]))),
            function_name: ScSymbol::try_from(b"deploy_pair".to_vec()).unwrap(),
            args: VecM::default(),
        }),
        sub_invocations: vec![nested_create].try_into().unwrap(),
    };

    let tx = build_factory_tx(factory_root);
    let inner = InnerTxRef::V1(&tx);

    let net = network_id(MAINNET_PASSPHRASE);
    let pairs = extract_sac_identities(&inner, &net);

    assert_eq!(pairs.len(), 1, "nested CreateContractHostFn discovered");
    assert!(matches!(pairs[0].1, SacAssetIdentity::Credit { ref code, .. } if code == "USDC"));
    assert_eq!(
        pairs[0].0, "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
        "USDC mainnet SAC contract_id derived from nested auth invocation"
    );
}

// ----------------------------------------------------------------------
// Task 0294 — `sac_override_from_event_topics` (the shared SAC gate)
// ----------------------------------------------------------------------

const USDC_SAC: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const NATIVE_SAC: &str = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

#[test]
fn helper_override_from_topics_positive_and_gate() {
    let net = network_id(MAINNET_PASSPHRASE);
    let topics = serde_json::json!([
        {"type": "sym", "value": "transfer"},
        {"type": "address", "value": "GFROM"},
        {"type": "address", "value": "GTO"},
        {"type": "string", "value": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"},
    ]);
    // positive: emitter IS the USDC SAC
    let ov = sac_override_from_event_topics(USDC_SAC, &topics, &net);
    assert_eq!(ov.expect("override").contract_id, USDC_SAC);
    // gate: wrong emitter (native SAC id) → rejected
    assert!(sac_override_from_event_topics(NATIVE_SAC, &topics, &net).is_none());
}
