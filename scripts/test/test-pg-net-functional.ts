#!/usr/bin/env bun
/**
 * pg_net owner: the background worker (preloaded by default) must complete real HTTP requests.
 * pgflow and realtime depend on it, and a worker that never starts, or a build without working
 * libcurl, still lets CREATE EXTENSION and net.http_* calls succeed — only a collected response
 * proves the request went out.
 *
 * The endpoint is a tiny Perl echo server in a second container from the SAME image (perl-base is
 * part of every Debian image), on a run-scoped Docker network: no internet, no extra image pull.
 *
 * Usage: bun scripts/test/test-pg-net-functional.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import {
  generateUniqueContainerName,
  generateUniqueProjectName,
  waitForPostgres,
} from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const image = resolveImageTag();
const network = generateUniqueProjectName("aza-pg-net");
const db = generateUniqueContainerName("aza-pg-net-db");
const echo = generateUniqueContainerName("aza-pg-net-echo");

/**
 * Answers every request with plain-text lines: method, request target, the x-aza-test header and
 * the body, so each test can see exactly what pg_net sent.
 */
const ECHO_SERVER = String.raw`
use IO::Socket::INET;
my $s = IO::Socket::INET->new(LocalPort => 8080, Listen => 16, ReuseAddr => 1) or die $!;
$| = 1; print "listening\n";
while (my $c = $s->accept) {
  my $line = <$c>; my ($method, $target) = split / /, $line;
  my ($len, $hdr) = (0, "");
  while (my $h = <$c>) {
    last if $h =~ /^\r?\n$/;
    $len = $1 if $h =~ /^content-length:\s*(\d+)/i;
    $hdr = $1 if $h =~ /^x-aza-test:\s*(\S+)/i;
  }
  my $body = ""; read($c, $body, $len) if $len;
  my $out = "method=$method\ntarget=$target\nx-aza-test=$hdr\nbody=$body\n";
  print $c "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " . length($out) . "\r\nConnection: close\r\n\r\n$out";
  close $c;
}`;

async function sql(query: string): Promise<string> {
  const r = await $`docker exec ${db} psql -X -v ON_ERROR_STOP=1 -U postgres -tA -c ${query}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) throw new Error(`${query}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** Wait for the worker to store the response for request `id`; returns `status|content`. */
async function collect(id: string): Promise<string> {
  const deadline = Date.now() + TIMEOUTS.health * 1000;
  while (Date.now() < deadline) {
    const row = await sql(
      `SELECT coalesce(status_code::text, 'ERR ' || error_msg) || '|' || coalesce(content, '') FROM net._http_response WHERE id = ${id}`
    );
    if (row !== "") return row;
    await Bun.sleep(200);
  }
  throw new Error(`no response stored for request ${id} after 20s (is the pg_net worker running?)`);
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  await $`docker network create ${network}`.quiet();
  await Promise.all([
    $`docker run -d --name ${echo} --network ${network} --entrypoint perl ${image} -e ${ECHO_SERVER}`.quiet(),
    $`docker run -d --name ${db} --network ${network} -e POSTGRES_PASSWORD=postgres ${image}`.quiet(),
  ]);
  const echoDeadline = Date.now() + TIMEOUTS.health * 1000;
  while (
    !(await $`docker logs ${echo}`.quiet().nothrow()).stdout.toString().includes("listening")
  ) {
    if (Date.now() > echoDeadline) throw new Error("echo server did not start");
    await Bun.sleep(100);
  }
  await waitForPostgres({ container: db, timeout: TIMEOUTS.startup });
  await sql("CREATE EXTENSION IF NOT EXISTS pg_net");

  await check("GET with query parameters and a custom header reaches the endpoint", async () => {
    const id = await sql(
      `SELECT net.http_get(url := 'http://${echo}:8080/get', params := '{"q": "aza"}'::jsonb, headers := '{"x-aza-test": "hdr-ok"}'::jsonb)`
    );
    const response = await collect(id);
    for (const expected of ["200|", "method=GET", "target=/get?q=aza", "x-aza-test=hdr-ok"]) {
      if (!response.includes(expected)) throw new Error(`missing "${expected}" in: ${response}`);
    }
  });

  await check("POST delivers its JSON body", async () => {
    const id = await sql(
      `SELECT net.http_post(url := 'http://${echo}:8080/post', body := '{"job": 42}'::jsonb)`
    );
    const response = await collect(id);
    for (const expected of ["200|", "method=POST", 'body={"job": 42}']) {
      if (!response.includes(expected)) throw new Error(`missing "${expected}" in: ${response}`);
    }
  });
} catch (err) {
  failures.push("setup");
  console.error(`FAIL: setup: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await $`docker rm -f -v ${db} ${echo}`.quiet().nothrow();
  await $`docker network rm ${network}`.quiet().nothrow();
}
process.exit(failures.length === 0 ? 0 : 1);
