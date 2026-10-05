export class SyncQueue {
    constructor() {
      this.active = new Set();
      this.pending = new Map();
    }

    isActive(type) {
        return this.active.has(type);
      }
  
      async queue(type, task) {
        if (this.isActive(type)) {
          if (!this.pending.has(type)) {
            this.pending.set(type, Promise.reject(new Error(`Sync already in progress for ${type}`)));
          }
          return this.pending.get(type);
        }
  
      // Mark this type as active
      this.active.add(type);
      
      const promise = (async () => {
        try {
          const result = await task();
          return result;
        } finally {
          this.active.delete(type);
          this.pending.delete(type);
        }
      })();
  
      this.pending.set(type, promise);
      return promise;
    }
  
    getActiveTypes() {
      return Array.from(this.active);
    }
  }
  
  // Create and export a single instance
  const syncQueue = new SyncQueue();
  export default syncQueue;