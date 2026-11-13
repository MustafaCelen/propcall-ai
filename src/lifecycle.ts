// Süreç kapanış bayrağı — server.ts gracefulShutdown başlar başlamaz set eder;
// uzun süreli döngüler (örn. campaign.ts fillQueue) yeni iş başlatmadan önce
// isShuttingDown() ile bakar. Ayrı modül: server.ts'i import etmeden okunabilsin.
let flag = false;
export const setShuttingDown = (): void => { flag = true; };
export const isShuttingDown = (): boolean => flag;
