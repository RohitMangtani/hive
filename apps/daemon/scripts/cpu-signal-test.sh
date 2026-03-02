#!/bin/bash
# CPU Signal Accuracy Test
# Samples CPU usage for all Claude agents every 2 seconds for N iterations.
# Cross-references against daemon's reported status.
# Outputs a CSV + accuracy report.
#
# Usage: ./scripts/cpu-signal-test.sh [iterations] [threshold]
#   iterations: number of samples (default: 60 = 2 minutes)
#   threshold:  CPU% above which we predict "working" (default: 5.0)

ITERATIONS=${1:-60}
THRESHOLD=${2:-5.0}
TOKEN=$(cat ~/.hive/token 2>/dev/null)
OUTFILE="/tmp/cpu-signal-test-$(date +%s).csv"

echo "CPU Signal Accuracy Test"
echo "========================"
echo "Iterations: $ITERATIONS (every 2s = $((ITERATIONS * 2))s total)"
echo "Threshold:  ${THRESHOLD}% CPU"
echo "Output:     $OUTFILE"
echo ""

# CSV header
echo "timestamp,tty,pid,cpu_pct,daemon_status,cpu_prediction,match" > "$OUTFILE"

correct=0
total=0
false_red=0   # CPU says working, daemon says idle
false_green=0 # CPU says idle, daemon says working

for i in $(seq 1 $ITERATIONS); do
  ts=$(date +%H:%M:%S)

  # Get daemon statuses in one call
  workers=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3001/api/workers 2>/dev/null)

  if [ -z "$workers" ]; then
    echo "[$ts] Daemon not responding, skipping..."
    sleep 2
    continue
  fi

  # Parse each worker
  echo "$workers" | python3 -c "
import json, sys, subprocess

threshold = float('$THRESHOLD')
data = json.load(sys.stdin)
results = []

for w in data:
    pid = w['pid']
    tty = w['tty']
    status = w['status']

    # Get CPU for this PID
    try:
        out = subprocess.check_output(['ps', '-p', str(pid), '-o', '%cpu='],
                                       stderr=subprocess.DEVNULL, text=True).strip()
        cpu = float(out) if out else 0.0
    except:
        cpu = 0.0

    # CPU prediction
    cpu_pred = 'working' if cpu > threshold else 'idle'

    # Normalize daemon status: 'stuck' counts as working for this test
    daemon_norm = 'working' if status in ('working', 'stuck') else 'idle'

    match = 'YES' if cpu_pred == daemon_norm else 'NO'

    results.append((tty, pid, cpu, status, cpu_pred, daemon_norm, match))
    print(f'$ts,{tty},{pid},{cpu:.1f},{status},{cpu_pred},{match}')

# Print live summary
for tty, pid, cpu, status, cpu_pred, daemon_norm, match in results:
    icon = '✓' if match == 'YES' else '✗'
    print(f'  [{icon}] {tty} pid={pid} cpu={cpu:5.1f}% daemon={status:8} predict={cpu_pred:8}', file=sys.stderr)
" >> "$OUTFILE" 2>&1

  # Progress
  if (( i % 10 == 0 )); then
    echo "--- Sample $i/$ITERATIONS ---"
  fi

  sleep 2
done

echo ""
echo "========================"
echo "RESULTS"
echo "========================"

# Analyze CSV
python3 -c "
import csv

correct = 0
total = 0
false_red = 0    # CPU=working but daemon=idle
false_green = 0  # CPU=idle but daemon=working
by_tty = {}

with open('$OUTFILE') as f:
    reader = csv.DictReader(f)
    for row in reader:
        if not row.get('match'):
            continue
        total += 1
        tty = row['tty']
        if tty not in by_tty:
            by_tty[tty] = {'correct': 0, 'total': 0, 'false_red': 0, 'false_green': 0}
        by_tty[tty]['total'] += 1

        if row['match'] == 'YES':
            correct += 1
            by_tty[tty]['correct'] += 1
        else:
            cpu_pred = row['cpu_prediction']
            daemon = row['daemon_status']
            if cpu_pred == 'working' and daemon == 'idle':
                false_red += 1
                by_tty[tty]['false_red'] += 1
            elif cpu_pred == 'idle' and daemon in ('working', 'stuck'):
                false_green += 1
                by_tty[tty]['false_green'] += 1

if total == 0:
    print('No data collected')
else:
    pct = (correct / total) * 100
    print(f'Overall accuracy: {correct}/{total} = {pct:.1f}%')
    print(f'False red  (CPU=working, daemon=idle): {false_red} ({false_red/total*100:.1f}%)')
    print(f'False green (CPU=idle, daemon=working): {false_green} ({false_green/total*100:.1f}%)')
    print()
    print('Per-TTY breakdown:')
    for tty in sorted(by_tty):
        d = by_tty[tty]
        pct = (d['correct'] / d['total']) * 100 if d['total'] > 0 else 0
        print(f'  {tty}: {d[\"correct\"]}/{d[\"total\"]} = {pct:.1f}%  (false_red={d[\"false_red\"]}, false_green={d[\"false_green\"]})')

    print()
    print('INTERPRETATION:')
    if false_green > 0:
        print(f'  ⚠ {false_green} times CPU said idle but daemon said working.')
        print('    These are the TEXT GENERATION gaps — CPU predicts correctly here.')
        print('    If daemon is wrong (agent was actually generating text), CPU wins.')
    if false_red > 0:
        print(f'  ⚠ {false_red} times CPU said working but daemon said idle.')
        print('    Possible: brief CPU spike during GC, or daemon detected idle before CPU settled.')
    if pct >= 95:
        print('  ✓ CPU signal is highly reliable as a status predictor.')
    elif pct >= 85:
        print('  ~ CPU signal is useful but needs combining with existing signals.')
    else:
        print('  ✗ CPU signal alone is not reliable enough.')
"

echo ""
echo "Raw data: $OUTFILE"
