import { shopifyRateLimiter } from './rate-limiter';

class DeleteQueue {
    constructor() {
      this.queue = [];
      this.isProcessing = false;
      this.retryDelay = 5000;
      this.maxRetries = 3;
      this.admin = null;     }

        setAdmin(admin) {
      this.admin = admin;
    }

    async add(items, vendor, admin) {
            this.setAdmin(admin);
      
      this.queue.push(...items.map(item => ({
        ...item,
        vendor,
        retries: 0
      })));

      console.log(`🗃️ Added ${items.length} items to delete queue for ${vendor}`);
      
      if (!this.isProcessing) {
        await this.process();
      }
    }

    async deleteProduct(productId) {
      if (!this.admin) {
        throw new Error('Admin instance not set');
      }

      const mutation = `#graphql
        mutation ($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors {
              field
              message
            }
          }
        }`;

      const variables = {
        input: {
          id: productId,
        },
      };

      const response = await this.admin.graphql(mutation, { variables });
      const data = await response.json();

      if (data.data.productDelete.userErrors.length > 0) {
        console.error('Error deleting product:', data.data.productDelete.userErrors);
        throw new Error('Error deleting product');
      }
    }

    async process() {
      if (this.isProcessing || this.queue.length === 0) return;
      if (!this.admin) {
        console.error('Cannot process queue: admin instance not set');
        return;
      }
      
      this.isProcessing = true;
      console.log(`🔄 Starting delete queue processing: ${this.queue.length} items`);

      while (this.queue.length > 0) {
        const item = this.queue.shift();
        
        try {
          await shopifyRateLimiter(async () => {
            console.log(`🗑️ Deleting product: ${item.title} (Vendor: ${item.vendor})`);
            await this.deleteProduct(item.id);
            console.log(`✅ Successfully deleted: ${item.title}`);
          });

        } catch (error) {
          console.error(`❌ Error deleting product: ${item.title}`, error);
          
          if (item.retries < this.maxRetries) {
            item.retries++;
            this.queue.push(item);
            console.log(`🔄 Requeueing ${item.title} for retry ${item.retries}/${this.maxRetries}`);
            await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          } else {
            console.error(`❌ Failed to delete ${item.title} after ${this.maxRetries} attempts`);
          }
        }
      }

      this.isProcessing = false;
      console.log('✅ Delete queue processing completed');
    }
}

export const deleteQueue = new DeleteQueue();