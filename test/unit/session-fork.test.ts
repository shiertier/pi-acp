import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  readonly created: any[] = []

  async create(params: any) {
    this.created.push(params)
    return {
      sessionId: 'fork-1',
      cwd: params.cwd,
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
        },
        async getAvailableThinkingLevels() {
          return ['medium', 'high']
        },
        async getCommands() {
          return { commands: [] }
        }
      },
      setStartupInfo() {
        assert.fail('a fork has no startup info')
      },
      async publishContextUsage() {}
    }
  }
}

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  })

  const store = new SessionStore(join(root, 'session-map.json'))
  const sessions = new FakeSessions()
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  Reflect.set(agent, 'sessions', sessions)
  Reflect.set(agent, 'store', store)
  return { root, store, sessions, agent }
}

test('PiAcpAgent: initialize advertises session/fork', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 })
  assert.deepEqual(res.agentCapabilities?.sessionCapabilities?.fork, {})
})

test('PiAcpAgent: forkSession starts pi on a copy of the source session file', async t => {
  const { root, store, sessions, agent } = setup(t)
  const sessionFile = join(root, 'source.jsonl')
  writeFileSync(sessionFile, '{"type":"session","id":"source"}\n')
  store.upsert({ sessionId: 'source', cwd: root, sessionFile })

  const res = await agent.unstable_forkSession({ sessionId: 'source', cwd: root })

  assert.equal(sessions.created.length, 1)
  assert.equal(sessions.created[0].forkFrom, sessionFile)
  assert.equal(sessions.created[0].cwd, root)
  assert.deepEqual(sessions.created[0].mcpServers, [])
  assert.equal(res.sessionId, 'fork-1')
  assert.deepEqual(
    res.configOptions?.map(option => option.id),
    ['model', 'thought_level']
  )
  assert.equal((res._meta as any)?.piAcp?.startupInfo, null)
})

test('PiAcpAgent: forkSession of a session pi has not written yet starts afresh', async t => {
  const { root, store, sessions, agent } = setup(t)
  store.upsert({ sessionId: 'source', cwd: root, sessionFile: join(root, 'not-written.jsonl') })

  const res = await agent.unstable_forkSession({ sessionId: 'source', cwd: root })

  assert.equal(sessions.created[0].forkFrom, undefined)
  assert.equal(res.sessionId, 'fork-1')
})

test('PiAcpAgent: forkSession rejects unknown sessions and relative paths', async t => {
  const { root, store, sessions, agent } = setup(t)
  await assert.rejects(agent.unstable_forkSession({ sessionId: 'missing', cwd: root }), { code: -32602 })

  const sessionFile = join(root, 'source.jsonl')
  writeFileSync(sessionFile, '{"type":"session","id":"source"}\n')
  store.upsert({ sessionId: 'source', cwd: root, sessionFile })
  await assert.rejects(agent.unstable_forkSession({ sessionId: 'source', cwd: 'relative' }), { code: -32602 })

  assert.equal(sessions.created.length, 0)
})

test('PiRpcProcess passes the session to fork to pi', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-launch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const argvFile = join(root, 'argv.json')
  const launcher = join(root, 'pi')
  writeFileSync(
    launcher,
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
      "require('node:readline').createInterface({ input: process.stdin }).on('line', line => {",
      '  const command = JSON.parse(line)',
      "  process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: {} }) + '\\n')",
      '})'
    ].join('\n')
  )
  chmodSync(launcher, 0o755)
  const source = join(root, 'source session.jsonl')

  const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher, forkFrom: source })
  proc.dispose()

  assert.deepEqual(JSON.parse(readFileSync(argvFile, 'utf8')), ['--mode', 'rpc', '--no-themes', '--fork', source])
})
