#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import App from "./app.js";
import "./db.js";
import { client } from "./client.js";

async function main() {
  if (!process.stdout.isTTY) {
    process.stderr.write("yapr needs an interactive terminal (stdout is not a TTY).\n");
    process.exit(1);
  }
  const enterAltScreen = () => process.stdout.write("\x1b[?1049h");
  const leaveAltScreen = () => process.stdout.write("\x1b[?1049l");
  enterAltScreen();
  // Kitty keyboard protocol in auto mode: terminals that speak it report
  // Shift+Enter distinctly (used as newline); everywhere else Ctrl+J does.
  // Unsupported terminals are untouched after the query timeout.
  const instance = render(React.createElement(App), { kittyKeyboard: { mode: "auto" } });

  client.start();

  try {
    await instance.waitUntilExit();
  } finally {
    client.stop();
    instance.unmount();
    leaveAltScreen();
  }
}

main().catch((err) => {
  process.stdout.write("\x1b[?1049l");
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
