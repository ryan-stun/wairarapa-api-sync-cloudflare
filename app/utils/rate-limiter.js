export const createRateLimiter = (maxRequests, timeWindow, maxRetries = 3) => {
  const requests = [];

  return async (fn) => {
    let attempts = 0;
    let lastError = null;

    while (attempts < maxRetries) {
      try {
        const now = Date.now();

        while (requests.length && requests[0] < now - timeWindow) {
          requests.shift();
        }

        // Wait if we've exceeded our rate limit
        if (requests.length >= maxRequests) {
          const oldestRequest = requests[0];
          const timeToWait = oldestRequest + timeWindow - now;
          await new Promise(resolve => setTimeout(resolve, timeToWait));
        } else if (requests.length > 0) {
          // Even if we haven't hit our limit, ensure minimum spacing between requests
          const lastRequest = requests[requests.length - 1];
          const timeSinceLast = now - lastRequest;

          if (timeSinceLast < timeWindow) {
            const minWait = timeWindow - timeSinceLast;
            await new Promise(resolve => setTimeout(resolve, minWait));
          }
        }

        // Record this request
        requests.push(Date.now()); // Use current time after any waits

        return await fn();
      } catch (error) {
        lastError = error;
        attempts++;
        console.warn(`Rate limit attempt ${attempts}/${maxRetries} failed:`, error.message);

        if (attempts === maxRetries) {
          console.error('Rate limit max retries reached:', error);
          throw error;
        }

        const backoffDelay = 1000 * Math.pow(2, attempts - 1);
        console.log(`Retrying in ${backoffDelay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }

    throw lastError || new Error('Rate limit failed');
  };
};

export const tourismNzRateLimiter = createRateLimiter(
  1, 2000, 3);

export const eventfindaRateLimiter = createRateLimiter(
  1, 1000, 5);

export const shopifyRateLimiter = createRateLimiter(
  1, 500, 5);