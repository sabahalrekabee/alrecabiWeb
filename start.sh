#!/bin/sh
npm run dev:vite &
VITE_PID=$!
npm run dev:wrangler
kill $VITE_PID
