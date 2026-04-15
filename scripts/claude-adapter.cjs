#!/usr/bin/env node

/**
 * claude-adapter.js
 * Translates Symphony's Codex App-Server JSON-RPC to Claude Code's stream-json format.
 */

const cp = require('child_process');
const readline = require('readline');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let childProcess = null;
let currentMessageId = 0;
let apiCallCount = 0;

function sendToOrchestrator(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function debugLog(msg) {
  // Can be viewed via orchestrator standard error
  process.stderr.write(`[adapter] ${msg}\n`);
}

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const msg = JSON.parse(line);
    
    // 1. Handshake Phase
    if (msg.method === 'initialize') {
      debugLog('Received initialize');
      sendToOrchestrator({ method: 'initialized' });
      // Symphony's runner.ts has a bug where initializeSession waits for thread ID 
      // before sending thread/start. We satisfy it immediately to avoid deadlock.
      sendToOrchestrator({ result: { thread: { id: "adapter-thread-1" } } });
    }
    
    // 2. Thread Session Setup Phase
    if (msg.method === 'thread/start') {
      const cwd = msg.params?.cwd || process.cwd();
      debugLog(`Received thread/start. Spawning Claude Code at ${cwd}`);
      
      const cliPath = path.resolve(__dirname, '../claude-code/bin/claude-haha');
      const args = [
        '-p',
        '--verbose',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--replay-user-messages',
        '--permission-mode', 'dontAsk'
      ];
      
      childProcess = cp.spawn(cliPath, args, {
        cwd: cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit'] // pipe stdin/stdout, let stderr inherit
      });
      
      // Intercept stream-json output
      childProcess.stdout.on('data', (data) => {
        const streamLines = data.toString().split('\n');
        for (const l of streamLines) {
          if (!l.trim()) continue;
          try {
            const ccMsg = JSON.parse(l);
            debugLog(`Claude emitted: ${ccMsg.type}`);
            
            // API Invocation and Rate Limit tracking
            if (ccMsg.type === 'system' && ccMsg.subtype === 'api_retry') {
              console.error(`[adapter] ⚠️ API Rate Limit Hit! Attempt: ${ccMsg.attempt}, Delay: ${Math.round(ccMsg.retry_delay_ms)}ms`);
            }
            if (ccMsg.type === 'system' && ccMsg.subtype === 'api_success') {
               // This can be used if claude releases api_success events
               console.log(`[adapter] API call succeeded.`);
            }
            
            if (ccMsg.type === 'assistant') {
              apiCallCount++;
            }
            
            // Completion detection
            if (ccMsg.type === 'result' && ccMsg.subtype === 'success') {
              const u = ccMsg.usage || {};
              console.log(`[adapter] 📊 Agent Task Finished. API Calls: ${apiCallCount}, Tokens: Input=${Number(u.input_tokens)||0}, Output=${Number(u.output_tokens)||0}`);
              sendToOrchestrator({
                method: 'turn/completed',
                result: {
                  turn: {
                    id: ccMsg.session_id || 'turn-1',
                    api_calls: apiCallCount,
                    tokens: {
                      input: Number(u.input_tokens) || 0,
                      output: Number(u.output_tokens) || 0,
                      total: (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
                    }
                  }
                }
              });
              apiCallCount = 0; // reset for next start
            } else if (ccMsg.type === 'error') {
              const errorMessage = ccMsg.message || ccMsg.error || 'Unknown Claude Error';
              console.error(`[adapter] 🚨 FATAL API ERROR: ${typeof errorMessage === 'object' ? JSON.stringify(errorMessage) : errorMessage}`);
              sendToOrchestrator({
                method: 'turn/failed',
                error: { code: -32000, message: typeof errorMessage === 'object' ? JSON.stringify(errorMessage) : errorMessage }
              });
            }
            // For observability in orchestrator
            else if (ccMsg.type === 'text_delta') {
               // We don't need to forward every token, but could track progress implicitly.
               // Runner.ts ignores unknown methods but prints them in debug mode.
               sendToOrchestrator({ method: 'turn/progress', text: ccMsg.text });
            } else if (ccMsg.type === 'tool_use') {
              debugLog(`Claude called tool: ${ccMsg.name}`);
            }
          } catch (e) {
            // Ignore incomplete lines or non-json
          }
        }
      });
      
      childProcess.on('exit', (code) => {
         debugLog(`Claude process exited with code ${code}`);
      });
      
      // Acknowledge thread start
      sendToOrchestrator({
        id: msg.id,
        result: { thread: { id: "adapter-thread-1" } }
      });
    }
    
    // 3. Turn Execution Phase
    if (msg.method === 'turn/start') {
      debugLog('Received turn/start');
      
      // Acknowledge turn start immediately (for logging inside Symphony target stream)
      sendToOrchestrator({ result: { turn: { id: "adapter-turn-1" } } });
      
      if (childProcess && childProcess.stdin.writable) {
        // Find the actual prompt. Orchestrator format: params.input[0].text
        let textPrompt = '';
        if (msg.params?.input && msg.params.input.length > 0) {
           textPrompt = msg.params.input[0].text;
        } else if (msg.params?.text) {
           textPrompt = msg.params.text;
        }
        
        debugLog(`Sending prompt to Claude (${textPrompt.length} bytes)`);
        
        const ccInput = {
          type: "user",
          message: { role: "user", content: textPrompt }
        };
        
        childProcess.stdin.write(JSON.stringify(ccInput) + '\n');
      } else {
        debugLog('Error: Claude process not available');
        sendToOrchestrator({
          method: 'turn/failed',
          result: { error: 'Claude process not spawned or stdin closed.' }
        });
      }
    }
    
  } catch (err) {
    debugLog(`Input parsing error: ${err.message}`);
  }
});

// Avoid Zombie / Ghost process leakage when Orchestrator crashes
rl.on('close', () => {
  debugLog('Standard input stream severed. Parent must have died. Committing suicide.');
  if (childProcess) {
    childProcess.kill('SIGKILL');
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (childProcess) childProcess.kill('SIGKILL');
  process.exit(0);
});

process.on('SIGINT', () => {
  if (childProcess) childProcess.kill('SIGKILL');
  process.exit(0);
});

debugLog('Started and listening for standard JSON-RPC');
