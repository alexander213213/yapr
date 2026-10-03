import { faker } from "@faker-js/faker";
import db from "./db.js";

const PEER_ID = "123142125";

db
// Seed contact (never touches other peers' history).
db.prepare(`
  INSERT OR IGNORE INTO contacts (peer_id, alias)
  VALUES (?, ?)
`).run(PEER_ID, faker.person.firstName());

// Prepare insert
const insert = db.prepare(`
  INSERT INTO messages (
    peer_id,
    direction,
    client_message_id,
    message_id,
    text,
    created_at,
    status
  ) VALUES (
    @peer_id,
    @direction,
    @client_message_id,
    @message_id,
    @text,
    @created_at,
    @status
  )
`);

function generateMessage(direction: "in" | "out", timestamp: number): {
  peer_id: string;
  direction: "in" | "out";
  client_message_id: string | null;
  message_id: string | null;
  text: string;
  created_at: number;
  status: "pending" | "sent" | "received";
} {
  const isOut = direction === "out";

  return {
    peer_id: PEER_ID,
    direction,
    client_message_id: isOut ? faker.string.uuid() : null,
    message_id: !isOut ? faker.string.uuid() : null,
    text: faker.lorem.sentences({ min: 1, max: 2 }),
    created_at: timestamp,
    status: isOut
      ? faker.helpers.arrayElement(["pending", "sent"])
      : "received"
  };
}

const messages: Array<{
  peer_id: string;
  direction: "in" | "out";
  client_message_id: string | null;
  message_id: string | null;
  text: string;
  created_at: number;
  status: "pending" | "sent" | "received";
}> = [];
let currentTime = Date.now() - 60 * 60 * 1000;

// Start with either side
let currentDirection: "in" | "out" = faker.helpers.arrayElement(["in", "out"]);

const TOTAL_MESSAGES = 60;

let i = 0;
while (i < TOTAL_MESSAGES) {
  // Decide burst size (how many consecutive messages)
  const burstSize = faker.number.int({ min: 1, max: 4 });

  for (let j = 0; j < burstSize && i < TOTAL_MESSAGES; j++) {
    currentTime += faker.number.int({ min: 2000, max: 20000 });

    messages.push(generateMessage(currentDirection, currentTime));
    i++;
  }

  // After a burst, maybe switch speaker
  const shouldSwitch = Math.random() < 0.7; // 70% chance to switch

  if (shouldSwitch) {
    currentDirection = currentDirection === "in" ? "out" : "in";
  }

  // Add a slightly longer pause between bursts
  currentTime += faker.number.int({ min: 10000, max: 60000 });
}

// Insert in a transaction (node:sqlite has no db.transaction helper).
db.exec("BEGIN IMMEDIATE");
try {
  for (const msg of messages) {
    insert.run(msg);
  }
  db.exec("COMMIT");
} catch (err) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Best effort.
  }
  throw err;
}

console.log(`Seeded ${messages.length} messages with bursts`);