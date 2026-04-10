import type { DeploymentParams } from "@easy1staking/cip113-sdk-ts";

/**
 * Deployment parameters for the CIP-113 protocol on Cardano preprod.
 *
 * These were produced by the protocol bootstrap transaction:
 * d01ae47ef64aa13282296aabf9283da869ba70697438052cad8a630abf140517
 */
export const PREPROD_DEPLOYMENT: DeploymentParams = {
  txHash: "d01ae47ef64aa13282296aabf9283da869ba70697438052cad8a630abf140517",

  protocolParams: {
    txInput: {
      txHash: "72286cb222fb335c8c3854f1d1de42fbe831e01048b759c3508e3825fdf8a4fa",
      outputIndex: 0,
    },
    policyId: "d4230b10ba4c8a4350212f9e9af80084aa3b886ac33b683a722b6ea9",
    alwaysFailScriptHash: "7df9369eb2ded40f5eac15bcb1ee0562d3dc53def0dab4ad26bae4e9",
  },

  programmableLogicGlobal: {
    policyId: "d0a12c8a72ecfa08457987ba294fada31eaac764a1772e9ee07ddcf7",
    scriptHash: "d0a12c8a72ecfa08457987ba294fada31eaac764a1772e9ee07ddcf7",
  },

  programmableLogicBase: {
    scriptHash: "c8b055ef3e2c0ba8b5c016e86fc59381f4397e375d250da9ea4758b9",
  },

  issuance: {
    txInput: {
      txHash: "72286cb222fb335c8c3854f1d1de42fbe831e01048b759c3508e3825fdf8a4fa",
      outputIndex: 1,
    },
    policyId: "203ac50ec29d7f7739781e42f02e0ec103f439677ec3be03cb9e7809",
    alwaysFailScriptHash: "5ff3439ab5b059889fbaf360195275d8471de9ad939e1bb6c3a7b74c",
  },

  directoryMint: {
    txInput: {
      txHash: "72286cb222fb335c8c3854f1d1de42fbe831e01048b759c3508e3825fdf8a4fa",
      outputIndex: 0,
    },
    issuanceScriptHash: "203ac50ec29d7f7739781e42f02e0ec103f439677ec3be03cb9e7809",
    scriptHash: "b9b19dc682ed108590277bb5301132b8b2c357cfbdb9138c01af5d1d",
  },

  directorySpend: {
    policyId: "d4230b10ba4c8a4350212f9e9af80084aa3b886ac33b683a722b6ea9",
    scriptHash: "116a5de7080ea7428a04aac13fa7e1c4d55544c019386b1dd91bfdef",
  },

  programmableBaseRefInput: {
    txHash: "d01ae47ef64aa13282296aabf9283da869ba70697438052cad8a630abf140517",
    outputIndex: 3,
  },

  programmableGlobalRefInput: {
    txHash: "d01ae47ef64aa13282296aabf9283da869ba70697438052cad8a630abf140517",
    outputIndex: 4,
  },
};
