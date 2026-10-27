function parseWorkerBody(messageData) {
  const body = messageData?.data?.message?.body ?? messageData?.message?.body;
  if (typeof body === "string")
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  return body && typeof body === "object" ? body : null;
}
