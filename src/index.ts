#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import App from "./app.js";
import "./db.js";
import { client } from "./client.js";

async function main() {
  process.stdout.write("\x1b[?1049h");
  const instance = render(React.createElement(App));

  client.start();

  try {
    await instance.waitUntilExit();
  } finally {
    client.stop();
    instance.unmount();
    process.stdout.write("\x1b[?1049l");
  }
}

main().catch((err) => {
  process.stdout.write("\x1b[?1049l");
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
