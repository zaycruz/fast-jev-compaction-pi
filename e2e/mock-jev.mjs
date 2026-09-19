/**
 * Minimal mock of the TypeSafe System One endpoint. Answers every `noul`
 * question with a fixed probability (configurable per answer prefix via env)
 * and records the last request body for inspection.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const port = Number(process.env.MOCK_PORT || 0);
const callProbability = Number(process.env.MOCK_CALL_P ?? 0.95);
const resultProbability = Number(process.env.MOCK_RESULT_P ?? 0.05);
const failWith = Number(process.env.MOCK_FAIL ?? 0);
const recordPath = process.env.MOCK_RECORD ?? "";

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    let questions = {};
    try {
      questions = JSON.parse(body).questions ?? {};
    } catch {
      // fall through with no questions
    }
    const answers = Object.fromEntries(
      Object.keys(questions).map((name) => [
        name,
        {
          type: "noul",
          noul: name.startsWith("call_") ? callProbability : resultProbability,
        },
      ]),
    );
    if (failWith > 0) {
      response.writeHead(failWith, { "content-type": "text/plain" });
      response.end("mock jev failure");
      return;
    }
    if (recordPath) writeFileSync(recordPath, body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answers, usage: { input_tokens: 4321, output_tokens: 21 } }));
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${address.port}\n`);
});
