import { parentPort, workerData } from "node:worker_threads";
import { blockText } from "@emend/core";

parentPort?.postMessage(blockText(workerData));
