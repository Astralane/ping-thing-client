// Sample use:
// node ping-thing-client.mjs >> ping-thing.log 2>&1 &

import dotenv from "dotenv";
import web3 from "@solana/web3.js";
import bs58 from "bs58";
import XMLHttpRequest from "xhr2";

// Catch interrupts & exit
process.on("SIGINT", function () {
  console.log(`${new Date().toISOString()} Caught interrupt signal`, "\n");
  process.exit();
});

// Read constants from .env
dotenv.config();
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const USER_KEYPAIR = web3.Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATE_KEYPAIR),
);

const SLEEP_MS_RPC = process.env.SLEEP_MS_RPC || 2000;
const SLEEP_MS_LOOP = process.env.SLEEP_MS_LOOP || 0;
const VA_API_KEY = process.env.VA_API_KEY;
// process.env.VERBOSE_LOG returns a string. e.g. 'true'
const VERBOSE_LOG = process.env.VERBOSE_LOG === "true" ? true : false;
const COMMITMENT_LEVEL = process.env.COMMITMENT || "confirmed";
const USE_PRIORITY_FEE = process.env.USE_PRIORITY_FEE == "true" ? true : false;

// Set up web3 client
// const walletAccount = new web3.PublicKey(USER_KEYPAIR.publicKey);
const connection = new web3.Connection(RPC_ENDPOINT, COMMITMENT_LEVEL);

// Set up our REST client
const restClient = new XMLHttpRequest();

if (VERBOSE_LOG) console.log(`${new Date().toISOString()} Starting script`);

// Pre-define loop constants & variables
const FAKE_SIGNATURE =
  "9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999";

// Run inside a loop that will exit after 3 consecutive failures
const MAX_TRIES = 3;
let tryCount = 0;

// Loop until interrupted
for (let i = 0; ; ++i) {
  // Sleep before the next loop
  if (i > 0) {
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS_LOOP));
  }

  try {
    let slotSent;
    let slotLanded;
    let signature;
    let txStart;

    try {
      const [blockhash, slotProcessed] = await Promise.all([
        connection.getLatestBlockhash("finalized"),
        connection.getSlot("processed"),
      ]);
      slotSent = slotProcessed;

      // Setup our transaction
      const tx = new web3.Transaction();

      if (USE_PRIORITY_FEE) {
        tx.add(
          web3.ComputeBudgetProgram.setComputeUnitLimit({
            units: process.env.CU_BUDGET || 5000,
          }),
          web3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: process.env.PRIORITY_FEE_MICRO_LAMPORTS || 3,
          }),
        );
      }

      tx.add(
        web3.SystemProgram.transfer({
          fromPubkey: USER_KEYPAIR.publicKey,
          toPubkey: USER_KEYPAIR.publicKey,
          lamports: 5000,
        }),
      );

      // Sign
      tx.lastValidBlockHeight = blockhash.lastValidBlockHeight;
      tx.recentBlockhash = blockhash.blockhash;
      tx.sign(USER_KEYPAIR);

      // Send and wait confirmation
      txStart = new Date();

      signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });

      const result = await connection.confirmTransaction(
        {
          signature,
          blockhash: tx.recentBlockhash,
          lastValidBlockHeight: tx.lastValidBlockHeight,
        },
        COMMITMENT_LEVEL,
      );
      if (result.value.err) {
        throw new Error(
          `Transaction ${signature} failed (${JSON.stringify(result.value)})`,
        );
      }
    } catch (e) {
      // Log and loop if we get a bad blockhash.
      if (e.message.includes("new blockhash")) {
        console.log(
          `${new Date().toISOString()} ERROR: Unable to obtain a new blockhash`,
        );
        continue;
      } else if (e.message.includes("Blockhash not found")) {
        console.log(`${new Date().toISOString()} ERROR: Blockhash not found`);
        continue;
      }

      // If the transaction expired on the chain. Make a log entry and send
      // to VA. Otherwise log and loop.
      if (e.name === "TransactionExpiredBlockheightExceededError") {
        console.log(
          `${new Date().toISOString()} ERROR: Blockhash expired/block height exceeded. TX failure sent to VA.`,
        );
      } else {
        console.log(`${new Date().toISOString()} ERROR: ${e.name}`);
        console.log(e.message);
        console.log(e);
        console.log(JSON.stringify(e));
        continue;
      }

      // Need to submit a fake signature to pass the import filters
      signature = FAKE_SIGNATURE;
    }

    const txEnd = new Date();

    // Sleep a little here to ensure the signature is on an RPC node.
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS_RPC));

    if (signature !== FAKE_SIGNATURE) {
      // Capture the slotLanded
      let txLanded = await connection.getTransaction(signature, {
        commitment: COMMITMENT_LEVEL,
        maxSupportedTransactionVersion: 255,
      });
      slotLanded = txLanded.slot;
    }

    // prepare the payload to send to validators.app
    const payload = JSON.stringify({
      time: txEnd - txStart,
      signature,
      transaction_type: "transfer",
      success: signature !== FAKE_SIGNATURE,
      application: "web3",
      commitment_level: COMMITMENT_LEVEL,
      slot_sent: slotSent,
      slot_landed: slotLanded,
    });

    if (VERBOSE_LOG) {
      console.log(`${new Date().toISOString()} ${payload}`);
    }

    // Send the ping data to validators.app
    restClient.open(
      "POST",
      "https://www.validators.app/api/v1/ping-thing/mainnet",
    );
    restClient.setRequestHeader("Content-Type", "application/json");
    restClient.setRequestHeader("Token", VA_API_KEY);
    restClient.send(payload);

    // Reset the try counter
    tryCount = 0;
  } catch (e) {
    console.log(`${new Date().toISOString()} ERROR: ${e.name}`);
    console.log(`${new Date().toISOString()} ERROR: ${e.message}`);
    if (++tryCount === MAX_TRIES) throw e;
  }
}
