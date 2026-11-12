const DEFAULT_HEARTBEAT_INTERVAL_MS = 8000;

function setStreamingJsonHeaders(res) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = 200;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  res.setHeader?.('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/**
 * 长任务在最终 JSON 返回前周期性发送空格。
 *
 * JSON.parse 允许前导空白，因此客户端仍会把它当作同一份 JSON 响应；
 * 中间的空白则能避免 Nginx 等反向代理把“暂时没有响应”误判为超时，
 * 最终返回自己的 HTML 502/504 页面。
 */
export function startJsonHeartbeat(res, options = {}) {
  const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS);
  const initialDelayMs = Number.isFinite(Number(options.initialDelayMs))
    ? Math.max(0, Number(options.initialDelayMs))
    : intervalMs;
  let stopped = false;
  let timer = null;

  const writeHeartbeat = () => {
    if (stopped || res.writableEnded || res.destroyed) return;
    if (!res.headersSent) setStreamingJsonHeaders(res);
    if (!res.writableEnded) res.write(' ');
  };

  timer = setTimeout(() => {
    writeHeartbeat();
    if (stopped) return;
    timer = setInterval(writeHeartbeat, intervalMs);
    timer.unref?.();
  }, initialDelayMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(timer);
  };
}

export function endJson(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.end(JSON.stringify(payload));
}
