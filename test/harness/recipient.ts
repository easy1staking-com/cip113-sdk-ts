/**
 * A recipient address with a DIFFERENT staking credential from the test wallet.
 *
 * Why not a second mnemonic: BIP39 phrases carry a checksum, so a second wallet
 * cannot simply be written by hand, and generating one would add a dependency
 * for no benefit here.
 *
 * What matters for a CIP-113 transfer is the STAKING credential: a programmable
 * token lives at `programmable_logic_base` + the holder's stake credential, so
 * two holders differ precisely when their stake credentials differ. This builds
 * a well-formed base address whose stake credential is distinct, which is
 * exactly the property under test.
 *
 * LIMITATION, stated rather than hidden: we do not hold this address's keys, so
 * this proves the transfer VALIDATED and the value MOVED — not that the
 * recipient can re-spend. Re-spending exercises the same programmable_logic_base
 * path the sender's side already exercises.
 */
import {
  AddressEras,
  BaseAddress,
  Bytes,
  KeyHash,
} from "@evolution-sdk/evolution";
import { paymentCredentialHash } from "../../dist/index.js";

/** Distinct, well-formed 28-byte stake credential. Fixed, so runs are comparable. */
export const RECIPIENT_STAKE_HASH = "7c".repeat(28);

export function recipientAddress(networkId: number, ownAddress: string): string {
  const addr = new BaseAddress.BaseAddress({
    networkId,
    paymentCredential: new KeyHash.KeyHash({
      hash: Bytes.fromHex(paymentCredentialHash(ownAddress)),
    }),
    stakeCredential: new KeyHash.KeyHash({
      hash: Bytes.fromHex(RECIPIENT_STAKE_HASH),
    }),
  });
  return AddressEras.toBech32(addr);
}
