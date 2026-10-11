#!/usr/bin/env bash
setsid bash -c 'exec -a claude-agent-escape-proof sleep 300' >/dev/null 2>&1 &
printf '%s\n' '{"type":"result","result":"CGROUP_TEST_OK","session_id":"00000000-0000-4000-8000-000000000001","usage":{"input_tokens":1,"output_tokens":1}}'
