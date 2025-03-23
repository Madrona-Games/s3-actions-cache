import * as core from "@actions/core";
import { saveCache } from "./utils";

process.on(
  "uncaughtException",
  (e) => core.info("warning: " + e.message + "\n" + e.stack),
);

saveCache(true);
