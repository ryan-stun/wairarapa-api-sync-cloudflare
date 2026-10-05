import { json } from "@remix-run/cloudflare";
import { Page, Layout, Text, BlockStack, Banner } from '@shopify/polaris';
import { useActionData } from '@remix-run/react';
import { authenticate } from '../shopify.server';
import { 
  fetchAllTourismListings, 
  fetchAllEventfindaListings, 
  updateSyncStatus, 
  processImages,
  fetchTourismBasicInfo
} from '../utils/api';
import { shopifyRateLimiter } from '../utils/rate-limiter';
import { deleteQueue } from '../utils/delete-queue';
import logo__eventfinda from '../images/logo__eventfinda.png';
import logo__tourismNZ from '../images/logo__tourismNZ.png';
import { SyncManager, ErrorBoundaryComponent } from '../components/SyncManager';
import { DebugHelper } from '../components/DebugHelper';

export function ErrorBoundary() {
  return <ErrorBoundaryComponent />;
}

const SYNC_BATCH_SIZE = 5;

function syncDatabase() {
  const db = globalThis.__CLOUDFLARE_DB__;
  if (!db) throw new Error('Cloudflare D1 binding DB is not available for sync jobs');
  return db;
}

async function saveSyncJob(job) {
  await syncDatabase().prepare(`
    INSERT INTO SyncJob (id, shop, listingType, vendor, isInitialSync, status, cursor, total, payload, deletePayload, deleteCursor, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    job.id, job.shop, job.listingType, job.vendor, job.isInitialSync ? 1 : 0,
    'processing', 0, job.total, JSON.stringify(job.payload), null, 0,
    Date.now(), Date.now()
  ).run();
}

async function loadSyncJob(id, shop) {
  return syncDatabase().prepare('SELECT * FROM SyncJob WHERE id = ? AND shop = ?').bind(id, shop).first();
}

async function updateSyncJob(id, fields) {
  const allowed = ['status', 'cursor', 'deletePayload', 'deleteCursor', 'updatedAt'];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  const sql = `UPDATE SyncJob SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
  await syncDatabase().prepare(sql).bind(...entries.map(([, value]) => value), id).run();
}

function makeJobId() {
  return crypto.randomUUID();
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const listingType = formData.get('listingType');
  const actionName = formData.get('action');
  const isInitialSync = formData.get('isInitialSync') === 'true';

  if (actionName === 'fetch-sample') {
    try {
      await fetchTourismBasicInfo(admin);
      return json({ success: true, action: 'fetch-sample' });
    } catch (error) {
      return json({ success: false, action: 'fetch-sample', message: `Error: ${error.message}` });
    }
  }

  if (actionName === 'status') return json({ success: true });

  try {
    // Every batch is a NEW Worker request. This is deliberate: Cloudflare counts
    // Shopify/Eventfinda/Tourism API calls as subrequests per Worker invocation.
    if (actionName === 'process-batch') {
      const jobId = formData.get('jobId');
      if (!jobId) throw new Error('Missing sync job ID');
      return await processSyncBatch(admin, session.shop, jobId);
    }

    updateSyncStatus(listingType, {
      status: 'syncing', progress: 0, phase: 'Fetching API data', details: 'Preparing sync job'
    });

    let vendor;
    let payload;
    let total;

    if (listingType === 'tourismNZ') {
      vendor = 'Tourism New Zealand';
      const tourismData = await fetchAllTourismListings(admin, isInitialSync);
      if (!tourismData?.listings || !Array.isArray(tourismData.listings)) {
        throw new Error('Invalid response from fetchAllTourismListings');
      }
      payload = { listings: tourismData.listings };
      total = tourismData.listings.length;
    } else if (listingType === 'eventfinda') {
      vendor = 'Eventfinda';
      const eventfindaData = await fetchAllEventfindaListings(admin, isInitialSync);
      if (!Array.isArray(eventfindaData?.changedListings) || !Array.isArray(eventfindaData?.allCurrentListings)) {
        throw new Error('Invalid response from fetchAllEventfindaListings');
      }
      payload = {
        listings: eventfindaData.changedListings,
        allCurrentListings: eventfindaData.allCurrentListings,
        syncTimestamp: eventfindaData.syncTimestamp ?? null,
      };
      total = eventfindaData.changedListings.length;
    } else {
      throw new Error(`Invalid listing type: ${listingType}`);
    }

    if (total === 0) {
      updateSyncStatus(listingType, { status: 'complete', progress: 100, phase: 'complete', details: 'No listings to process' });
      return json({ success: true, status: 'complete', listingType, message: `${listingType} sync complete - no listings to process` });
    }

    const jobId = makeJobId();
    await saveSyncJob({
      id: jobId, shop: session.shop, listingType, vendor, isInitialSync,
      total, payload
    });

    console.log(`🧩 Created ${listingType} sync job ${jobId}: ${total} listings, batch size ${SYNC_BATCH_SIZE}`);
    return json({
      success: true, status: 'batching', listingType, jobId, batchToken: 'start',
      progress: 0, processed: 0, total,
      message: `Prepared ${total} listings. Starting batched sync.`
    });
  } catch (error) {
    console.error('Error in action handler:', error);
    if (listingType) updateSyncStatus(listingType, { status: 'error', progress: 0, phase: 'error', details: error.message });
    return json({ success: false, listingType, message: 'An error occurred', error: error.message });
  }
}

async function processSyncBatch(admin, shop, jobId) {
  const job = await loadSyncJob(jobId, shop);
  if (!job) throw new Error('Sync job not found');

  const payload = JSON.parse(job.payload);
  const listings = payload.listings || [];
  const listingType = job.listingType;
  const vendor = job.vendor;

  // Product create/update phase.
  if (job.status === 'processing') {
    const start = Number(job.cursor || 0);
    const end = Math.min(start + SYNC_BATCH_SIZE, listings.length);
    const batch = listings.slice(start, end);
    const existingProducts = await shopifyRateLimiter(() => getExistingProducts(admin, vendor));

    console.log(`🧩 ${vendor} batch ${start + 1}-${end} of ${listings.length}`);
    for (const listing of batch) {
      if (!listing) continue;
      const existingProduct = findMatchingProduct(listing, existingProducts, vendor);
      await shopifyRateLimiter(async () => {
        if (existingProduct) {
          console.log(`🔄 Updating: ${listing.title}`);
          await updateProduct(admin, existingProduct.id, listing, vendor);
        } else if (vendor === 'Eventfinda') {
          console.log(`➕ Creating: ${listing.title}`);
          await createProduct(admin, listing, vendor);
        } else {
          // Tourism NZ is curated: preserve the original intent and don't create
          // unmatched API listings automatically.
          console.log(`⏭️ Tourism NZ listing has no matching curated product; skipping: ${listing.title}`);
        }
      });
    }

    await updateSyncJob(jobId, { cursor: end, updatedAt: Date.now() });
    const progress = Math.min(95, Math.round((end / Math.max(listings.length, 1)) * 90));
    updateSyncStatus(listingType, { status: 'syncing', progress, phase: 'Updating Products', details: `Processed ${end}/${listings.length}` });

    if (end < listings.length) {
      return json({ success: true, status: 'batching', listingType, jobId, batchToken: `products:${end}`, progress, processed: end, total: listings.length });
    }

    // Calculate deletions once all create/update batches are finished. Deletions
    // themselves are also batched so a large cleanup cannot hit the same limit.
    const refreshedProducts = await shopifyRateLimiter(() => getExistingProducts(admin, vendor));
    let productsToDelete = [];

    if (vendor === 'Eventfinda') {
      const currentIds = new Set((payload.allCurrentListings || []).map(id => id?.toString()));
      productsToDelete = refreshedProducts.filter(product =>
        product.metafield?.value && !currentIds.has(product.metafield.value.toString())
      );
    } else {
      productsToDelete = refreshedProducts.filter(product => !listings.some(listing =>
        normalized(listing.title) === normalized(product.title) &&
        (listing.productType?.trim().replace(/\s+/g, ' ') || '') === (product.productType?.trim().replace(/\s+/g, ' ') || '')
      ));
    }

    if (productsToDelete.length === 0) {
      await updateSyncJob(jobId, { status: 'complete', updatedAt: Date.now() });
      updateSyncStatus(listingType, { status: 'complete', progress: 100, phase: 'complete', details: 'Sync completed successfully' });
      console.log(`✅ ${vendor} batched sync complete; no deletions required`);
      return json({ success: true, status: 'complete', listingType, jobId, progress: 100, processed: listings.length, total: listings.length });
    }

    await updateSyncJob(jobId, {
      status: 'deleting',
      deletePayload: JSON.stringify(productsToDelete.map(p => ({ id: p.id, title: p.title }))),
      deleteCursor: 0,
      updatedAt: Date.now()
    });
    console.log(`🗑️ ${productsToDelete.length} deletions queued for batched processing`);
    return json({ success: true, status: 'batching', listingType, jobId, batchToken: 'deletions:0', progress: 95, processed: listings.length, total: listings.length });
  }

  // Deletion phase.
  if (job.status === 'deleting') {
    const deletions = JSON.parse(job.deletePayload || '[]');
    const start = Number(job.deleteCursor || 0);
    const end = Math.min(start + SYNC_BATCH_SIZE, deletions.length);
    const batch = deletions.slice(start, end);
    if (batch.length) await deleteQueue.add(batch, vendor, admin);
    await updateSyncJob(jobId, { deleteCursor: end, updatedAt: Date.now() });

    if (end < deletions.length) {
      return json({ success: true, status: 'batching', listingType, jobId, batchToken: `deletions:${end}`, progress: 97, processed: listings.length, total: listings.length });
    }

    await updateSyncJob(jobId, { status: 'complete', updatedAt: Date.now() });
    updateSyncStatus(listingType, { status: 'complete', progress: 100, phase: 'complete', details: 'Sync completed successfully' });
    console.log(`✅ ${vendor} batched sync complete including ${deletions.length} deletions`);
    return json({ success: true, status: 'complete', listingType, jobId, progress: 100, processed: listings.length, total: listings.length });
  }

  if (job.status === 'complete') {
    return json({ success: true, status: 'complete', listingType, jobId, progress: 100, processed: listings.length, total: listings.length });
  }

  throw new Error(`Unexpected sync job status: ${job.status}`);
}

async function getExistingProducts(admin, vendor) {
    const response = await admin.graphql(`#graphql
    query {
      products(first: 250, query: "vendor:${vendor}") {
        edges {
          node {
            id
            title
            handle
            productType
            vendor
            metafield(namespace: "custom", key: "listing_id") {
              value
            }
          }
        }
      }
    }
  `);
    const data = await response.json();
    return data.data.products.edges.map(edge => edge.node);
}

async function createProduct(admin, listing, vendor) {
    const media = await processImages([listing]);

    let templateSuffix = '';
    if (vendor === 'Tourism New Zealand' && listing.productType === 'Accommodation') {
        templateSuffix = 'accommodation';
    } else if (vendor === 'Tourism New Zealand' && listing.productType === 'Activity') {
        templateSuffix = 'see-and-do';
    } else if (vendor === 'Tourism New Zealand' && listing.productType === 'Tour') {
        templateSuffix = 'see-and-do';
    } else if (vendor === 'Tourism New Zealand' && listing.productType === 'Transport') {
        templateSuffix = 'see-and-do';
    } else if (vendor === 'Eventfinda' && listing.productType === 'Event') {
        templateSuffix = 'whats-on';
    }

    const createMutation = `#graphql
    mutation ($input: ProductInput!, $media: [CreateMediaInput!]) {
      productCreate(input: $input, media: $media) {
        product {
          id
          title
          media(first: 10) {
            edges {
              node {
                id
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

    let variables = {
        input: {
            descriptionHtml: listing.description,
            metafields: listing.metafields,
            productType: listing.productType,
            published: true,
            seo: {
                description: stripHtml(listing.description).substring(0, 160),
                title: listing.title
            },
            title: listing.title,
          //  templateSuffix: templateSuffix,
            vendor: listing.vendor
        },
        media,
    };

    if (listing.vendor === 'Eventfinda') {
        variables.input.tags = listing.tags;
    }

    if (listing.vendor === 'Eventfinda') {
      variables.input.templateSuffix = 'whats-on';
    }

    const createResponse = await admin.graphql(createMutation, { variables });
    const createData = await createResponse.json();

    if (createData.data.productCreate.userErrors.length > 0) {
        console.error('Error creating product:', createData.data.productCreate.userErrors);
        return;
    }
}

async function updateProduct(admin, productId, listing, vendor) {
  let media = [];
  if (vendor === 'Tourism New Zealand' || vendor === 'Eventfinda') {
      media = await processImages([listing]);
  }

  // First, fetch existing media
  const fetchProductQuery = `#graphql
  query ($id: ID!) {
    product(id: $id) {
      media(first: 10) {
        edges {
          node {
            id
          }
        }
      }
    }
  }`;

  const fetchVariables = {
      id: productId,
  };

  const fetchResponse = await admin.graphql(fetchProductQuery, { variables: fetchVariables });
  const fetchData = await fetchResponse.json();

  if (fetchData.errors) {
      console.error('Error fetching product:', fetchData.errors);
      throw new Error('Error fetching product');
  }

  const existingMedia = fetchData.data.product.media.edges;

  // If there's existing media, delete it first
  if (existingMedia.length > 0) {
      const deleteMediaMutation = `#graphql
      mutation deleteMedias($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
          deletedMediaIds
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`;

      const deleteVariables = {
          productId: productId,
          mediaIds: existingMedia.map(edge => edge.node.id)
      };

      console.log(`🗑️ Deleting ${existingMedia.length} existing media items for product: ${productId}`);

      const deleteResponse = await admin.graphql(deleteMediaMutation, { variables: deleteVariables });
      const deleteData = await deleteResponse.json();

      if (deleteData.errors || deleteData.data.productDeleteMedia.userErrors.length > 0) {
          console.error('Error deleting existing media:', 
              deleteData.errors || deleteData.data.productDeleteMedia.userErrors);
          throw new Error('Error deleting existing media');
      }
  }

  // Set template suffix based on product type
  let templateSuffix = '';
  if (vendor === 'Tourism New Zealand') {
      templateSuffix = listing.productType === 'Accommodation' ? 'accommodation' : 'see-and-do';
  } else if (vendor === 'Eventfinda' && listing.productType === 'Event') {
      templateSuffix = 'whats-on';
  }

  // Update product with new media
  const productDetailsMutation = `#graphql
  mutation productUpdate($input: ProductInput!, $media: [CreateMediaInput!]) {
    productUpdate(input: $input, media: $media) {
      product {
        id,
        media(first: 10) {
          edges {
            node {
              id
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }`;

  // Always include media in the update
  const variables = {
      input: {
          id: productId,
          descriptionHtml: listing.description,
          productType: listing.productType,
          seo: {
              description: stripHtml(listing.description).substring(0, 160),
              title: listing.title
          },
          title: listing.title,
         // templateSuffix: templateSuffix,
          vendor: listing.vendor
      },
      media // Always include new media
  };

  console.log(`🖼️ Updating product with ${media.length} new media items`);

  const productUpdateResponse = await admin.graphql(productDetailsMutation, { variables });
  const productData = await productUpdateResponse.json();

  if (productData.data.productUpdate.userErrors.length > 0) {
      console.error('Error updating product details:', productData.data.productUpdate.userErrors);
      throw new Error('Error updating product details');
  }

  // Update metafields
  const updatedMetafields = listing.metafields
      .map(metafield => ({
          ...metafield,
          ownerId: productId
      }))
      .filter(metafield => metafield !== null && metafield.value !== undefined && metafield.value !== null);

  if (updatedMetafields.length > 0) {
      const metafieldsUpdateMutation = `#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`;

      const metafieldsVariables = {
          metafields: updatedMetafields
      };

      console.log(`📝 Updating ${updatedMetafields.length} metafields`);

      const metafieldsUpdateResponse = await admin.graphql(metafieldsUpdateMutation, { variables: metafieldsVariables });
      const metafieldsData = await metafieldsUpdateResponse.json();
      
      if (metafieldsData.data.metafieldsSet.userErrors.length > 0) {
          console.error('Error updating metafields:', metafieldsData.data.metafieldsSet.userErrors);
          throw new Error('Error updating metafields');
      }
  }

  console.log(`✅ Successfully updated product ${productId} with new media and metafields`);
}

function findMatchingProduct(listing, existingProducts, vendor) {
  if (vendor === 'Eventfinda') {
    return existingProducts.find(product =>
      product.metafield?.value === listing.listing_id.toString()
    );
  }
  
  const normalizedListingTitle = normalized(listing.title);
  // Normalize product type - remove extra whitespace
  const normalizedListingType = listing.productType?.trim().replace(/\s+/g, ' ') || '';
  
  const match = existingProducts.find(product => {
    const normalizedProductTitle = normalized(product.title);
    const normalizedProductType = product.productType?.trim().replace(/\s+/g, ' ') || '';
    
    // Compare normalized values
    const typeMatch = normalizedProductType === normalizedListingType;
    const titleMatch = normalizedProductTitle === normalizedListingTitle;
    
    // Log each potential match with detailed info
    if (titleMatch && !typeMatch) {
      console.log(`⚠️ Title match but type mismatch: "${product.title}"`);
      console.log(`   Store type: "${product.productType}" (normalized: "${normalizedProductType}")`);
      console.log(`   API type: "${listing.productType}" (normalized: "${normalizedListingType}")`);
    }
    
    return titleMatch && typeMatch;
  });
  
  if (match) {
    console.log(`✅ Found match: "${match.title}" (${match.productType})`);
  } else {
    // Log potential near-misses for debugging
    const nearTitleMatches = existingProducts.filter(product => {
      const normalizedProductTitle = normalized(product.title);
      return normalizedProductTitle.includes(normalizedListingTitle) || 
             normalizedListingTitle.includes(normalizedProductTitle);
    });
    
    if (nearTitleMatches.length > 0) {
      console.log(`ℹ️ Found ${nearTitleMatches.length} near title matches, but no exact match with type`);
      nearTitleMatches.slice(0, 3).forEach(product => {
        console.log(`  - Near miss: "${product.title}" (Type: ${product.productType})`);
      });
    } else {
      console.log(`❌ No title matches found among ${existingProducts.length} products`);
    }
  }
  
  return match;
}

async function syncListings(admin, listingsData, vendor) {
  const vendorKey = vendor === 'Tourism New Zealand' ? 'tourismNZ' : 
                    vendor.toLowerCase() === 'eventfinda' ? 'eventfinda' : null;
  
  if (!vendorKey) {
    throw new Error(`Invalid vendor: ${vendor}. Expected 'Tourism New Zealand' or 'Eventfinda'`);
  }

  console.log('📝 Vendor details:', {
    originalVendor: vendor,
    vendorKey: vendorKey,
  });

  updateSyncStatus(vendorKey, {
    status: 'syncing',
    progress: 0, 
    phase: 'Updating Products'
  });

  try {
    // Handle each vendor type differently
    if (vendor === 'Eventfinda') {
      // For Eventfinda, use the three-category approach
      const { changedListings = [], allCurrentListings = [], syncTimestamp } = listingsData;
      
      console.log(`\n🔄 Starting sync for ${vendor}`);
      console.log(`📦 Total recently changed listings to process: ${changedListings?.length || 0}`);
      console.log(`📦 Total current listings in API: ${allCurrentListings?.length || 0}`);

      // Get existing products from Shopify
      const existingProducts = await shopifyRateLimiter(async () => {
        return getExistingProducts(admin, vendor);
      });
      console.log(`🏪 Existing products in store: ${existingProducts?.length || 0}`);

      // Create maps for faster lookups
      const existingProductMap = new Map();
      existingProducts.forEach(product => {
        if (product.metafield?.value) {
          existingProductMap.set(product.metafield.value, product);
        }
      });
      
      // Track which existing products we've processed
      const processedExistingIds = new Set();
      
      // Track stats for reporting
      let newCount = 0;
      let updatedCount = 0;
      
      const totalToProcess = changedListings?.length || 0;
      
      // Process only the changed listings (created or modified in the last 24h)
      for (let i = 0; i < totalToProcess; i++) {
        const listing = changedListings[i];
        if (!listing) {
          console.warn(`⚠️ Null or undefined listing found at index ${i}`);
          continue;
        }
        
        const eventId = listing.listing_id?.toString() || '';
        if (!eventId) {
          console.warn(`⚠️ Missing listing_id for item: ${listing?.title || 'Unknown'}`);
          continue;
        }
        
        const progress = Math.round((i / totalToProcess) * 100);
        
        updateSyncStatus(vendorKey, {
          status: 'syncing',
          progress,
          phase: 'Updating Products',
          details: `Processing ${i + 1}/${totalToProcess}`
        });

        // Check if this is a new or existing event
        if (!existingProductMap.has(eventId)) {
          // Category 1: New event - create it
          await shopifyRateLimiter(async () => {
            console.log(`➕ Creating new event: ${listing.title} (ID: ${eventId})`);
            await createProduct(admin, listing, vendor);
            newCount++;
          });
        } else {
          // Category 2: Modified event - update it
          const existingProduct = existingProductMap.get(eventId);
          
          // Mark this ID as processed
          processedExistingIds.add(eventId);
          
          await shopifyRateLimiter(async () => {
            console.log(`🔄 Updating modified event: ${listing.title} (ID: ${eventId})`);
            await updateProduct(admin, existingProduct.id, listing, vendor);
            updatedCount++;
          });
        }
      }
      
      // Category 3: Deleted events - find and delete events that no longer exist in the API
      console.log('🔍 Checking for products to delete...');
      
      // Determine which existing products should be deleted
      // (those that exist in Shopify but aren't in the current API listings)
      const productsToDelete = existingProducts.filter(product => {
        // Check if we have a listing ID
        if (!product.metafield?.value) return false;
        
        // Check if this ID exists in the current API response
        const stillExists = allCurrentListings.some(id => 
          id?.toString() === product.metafield.value?.toString()
        );
        
        // If it doesn't exist and hasn't been processed, mark for deletion
        if (!stillExists) {
          console.log(`❌ Product marked for deletion: ${product.title} (ID: ${product.metafield.value})`);
          return true;
        }
        
        return false;
      });
      
      if (productsToDelete.length > 0) {
        console.log(`🗑️ Queueing ${productsToDelete.length} products for deletion`);
        await deleteQueue.add(productsToDelete, vendor, admin);
      } else {
        console.log(`✅ No products need to be deleted for ${vendor}`);
      }
      
      // Print detailed report
      console.log(`\n📊 Sync Completion Report for ${vendor}:`);
      console.log(`📝 Total changed listings processed: ${changedListings?.length || 0}`);
      console.log(`➕ New products created: ${newCount}`);
      console.log(`🔄 Existing products updated: ${updatedCount}`);
      console.log(`🗑️ Products to be deleted: ${productsToDelete?.length || 0}`);
      console.log(`⏭️ Products skipped (unchanged): ${existingProducts?.length - updatedCount - (productsToDelete?.length || 0)}`);
      
    } else {
      // Original logic for Tourism NZ
      const listings = listingsData;
      const totalListings = listings?.length || 0;
      
      console.log(`\n🔄 Starting sync for ${vendor}`);
      console.log(`📦 Total listings to process: ${totalListings}`);

      const existingProducts = await shopifyRateLimiter(async () => {
        return getExistingProducts(admin, vendor);
      });
      console.log(`🏪 Existing products in store: ${existingProducts?.length || 0}`);
      
      for (let i = 0; i < totalListings; i++) {
        const listing = listings[i];
        if (!listing) {
          console.warn(`⚠️ Null or undefined listing found at index ${i}`);
          continue;
        }
        
        const progress = Math.round((i / totalListings) * 100);

        updateSyncStatus(vendorKey, {
          status: 'syncing',
          progress,
          phase: 'Updating Products',
          details: `Processing ${i + 1}/${totalListings}`
        });

        await shopifyRateLimiter(async () => {
          console.log(`🔍 Finding matching product for: ${listing.title} (Normalized: ${normalized(listing.title)})`);
          
          // Log existing products to check normalization
          if (i === 0) { // Only log once to avoid spam
            console.log(`📋 First 5 existing products for comparison:`);
            existingProducts.slice(0, 5).forEach(product => {
              console.log(`  - ${product.title} (Normalized: ${normalized(product.title)}, Type: ${product.productType})`);
            });
          }
          
          const existingProduct = findMatchingProduct(listing, existingProducts, vendor);
          
          if (existingProduct) {
            console.log(`✅ Match found! Updating: ${existingProduct.title} (ID: ${existingProduct.id})`);
            await updateProduct(admin, existingProduct.id, listing, vendor);
          } else {
            console.log(`❓ No match found. Creating new product: ${listing.title} (Type: ${listing.productType})`);
            await createProduct(admin, listing, vendor);
          }
        });
      }
      
      // Handle deletions
      {
        try {
          console.log('🔍 Checking for products to delete...');
          
          // ADD DEFENSIVE LOGGING HERE - BEFORE the filter
          console.log('\n📊 Deletion Check Debug Info:');
          console.log(`Total existing products in store: ${existingProducts.length}`);
          console.log(`Total listings fetched from API: ${listings.length}`);
          
          // Log a few examples of what we're comparing
          if (existingProducts.length > 0) {
            console.log('\n📋 Sample existing products (first 3):');
            existingProducts.slice(0, 3).forEach(product => {
              console.log(`  - "${product.title}" (Normalized: "${normalized(product.title)}", Type: ${product.productType})`);
            });
          }
          
          if (listings.length > 0) {
            console.log('\n📋 Sample API listings (first 3):');
            listings.slice(0, 3).forEach(listing => {
              console.log(`  - "${listing.title}" (Normalized: "${normalized(listing.title)}", Type: ${listing.productType})`);
            });
          }
          
          const productsToDelete = existingProducts.filter(product => {
            const matchFound = listings.some(listing => {
              const titleMatch = normalized(listing.title) === normalized(product.title);
              // Normalize product types for comparison
              const normalizedListingType = listing.productType?.trim().replace(/\s+/g, ' ') || '';
              const normalizedProductType = product.productType?.trim().replace(/\s+/g, ' ') || '';
              const typeMatch = normalizedListingType === normalizedProductType;
              
              return titleMatch && typeMatch;
            });
            
            // ADD DETAILED LOGGING FOR EACH PRODUCT BEING EVALUATED
            if (!matchFound) {
              console.log(`\n⚠️ Marking for deletion: "${product.title}"`);
              console.log(`  Product Type: "${product.productType}"`);
              console.log(`  Normalized Title: "${normalized(product.title)}"`);
              console.log(`  Normalized Type: "${product.productType?.trim().replace(/\s+/g, ' ')}"`);
              console.log(`  Reason: No matching listing found in API response`);
              
              // Check for near matches to help debug
              const nearMatches = listings.filter(listing => {
                const normalizedProductTitle = normalized(product.title);
                const normalizedListingTitle = normalized(listing.title);
                return normalizedProductTitle.includes(normalizedListingTitle) || 
                       normalizedListingTitle.includes(normalizedProductTitle);
              });
              
              if (nearMatches.length > 0) {
                console.log(`  ⚠️ Found ${nearMatches.length} near title matches:`);
                nearMatches.forEach(match => {
                  console.log(`    - "${match.title}" (Type: "${match.productType}")`);
                });
              }
            }
            
            return !matchFound;
          });
      
          if (productsToDelete.length > 0) {
            console.log(`\n🗑️ Queueing ${productsToDelete.length} products for deletion`);
            console.log('Products to delete:');
            productsToDelete.forEach(product => {
              console.log(`  - ${product.title} (${product.productType})`);
            });
            await deleteQueue.add(productsToDelete, vendor, admin);           
            console.log(`\n✅ Products queued for deletion for ${vendor}:`, {
              processed: totalListings,
              queued: productsToDelete.length,
              vendorKey: vendorKey
            });
          } else {
            console.log(`✅ No products need to be deleted for ${vendor}`);
          }
        } catch (error) {
          console.error('❌ Error in deletion check:', error, {
            vendor: vendor,
            vendorKey: vendorKey
          });
        }
      }
      
      // Print report for Tourism NZ
      console.log(`\n📊 Sync Completion Report for ${vendor}:`);
      console.log(`📝 Total listings processed: ${totalListings}`);
      
      // Count how many were updated vs created
      const updatedCount = listings.filter(listing => {
        const existingProduct = findMatchingProduct(listing, existingProducts, vendor);
        return existingProduct !== undefined;
      }).length;
      
      const createdCount = totalListings - updatedCount;
      console.log(`🔄 Updated products: ${updatedCount}`);
      console.log(`➕ Created products: ${createdCount}`);

      // ADD DETAILED SYNC REPORT HERE:
console.log('\n' + '='.repeat(80));
console.log('📋 DETAILED SYNC REPORT');
console.log('='.repeat(80));

// 1. Products in store
console.log(`\n🏪 PRODUCTS IN STORE (${existingProducts.length} total):`);
existingProducts.forEach((product, index) => {
  console.log(`${index + 1}. "${product.title}" (${product.productType})`);
});

// 2. Listings fetched from API
console.log(`\n🌐 LISTINGS FETCHED FROM API (${listings.length} total):`);
listings.forEach((listing, index) => {
  console.log(`${index + 1}. "${listing.title}" (${listing.productType})`);
});

// 3. Products that were updated (matched and synced)
console.log(`\n✅ PRODUCTS UPDATED (${updatedCount} total):`);
const updatedProducts = listings.filter(listing => {
  const existingProduct = findMatchingProduct(listing, existingProducts, vendor);
  return existingProduct !== undefined;
});
updatedProducts.forEach((listing, index) => {
  const matchedProduct = findMatchingProduct(listing, existingProducts, vendor);
  console.log(`${index + 1}. "${listing.title}" (${listing.productType})`);
  console.log(`   Matched with: "${matchedProduct.title}"`);
});

// 4. Products that were created (new from API)
console.log(`\n➕ PRODUCTS CREATED (${createdCount} total):`);
const createdProducts = listings.filter(listing => {
  const existingProduct = findMatchingProduct(listing, existingProducts, vendor);
  return existingProduct === undefined;
});
createdProducts.forEach((listing, index) => {
  console.log(`${index + 1}. "${listing.title}" (${listing.productType})`);
});

// 5. Products in store that were NOT synced (exist in store but not in API response)
console.log(`\n⚠️ PRODUCTS IN STORE NOT FOUND IN API (will be checked for deletion):`);
const notSyncedProducts = existingProducts.filter(product => {
  return !listings.some(listing => 
    normalized(listing.title) === normalized(product.title) && 
    listing.productType === product.productType
  );
});
console.log(`Total: ${notSyncedProducts.length}`);
notSyncedProducts.forEach((product, index) => {
  console.log(`${index + 1}. "${product.title}" (${product.productType})`);
  console.log(`   Normalized: "${normalized(product.title)}"`);
  
  // Show if there are any near matches in API
  const nearMatches = listings.filter(listing => {
    const normalizedProductTitle = normalized(product.title);
    const normalizedListingTitle = normalized(listing.title);
    return normalizedProductTitle.includes(normalizedListingTitle) || 
           normalizedListingTitle.includes(normalizedProductTitle);
  });
  
  if (nearMatches.length > 0) {
    console.log(`   Near matches in API:`);
    nearMatches.forEach(match => {
      console.log(`     - "${match.title}" (${match.productType})`);
    });
  }
});

// 6. Summary statistics
console.log(`\n📈 SUMMARY STATISTICS:`);
console.log(`   Store Products: ${existingProducts.length}`);
console.log(`   API Listings: ${listings.length}`);
console.log(`   Updated: ${updatedCount}`);
console.log(`   Created: ${createdCount}`);
console.log(`   Not Synced: ${notSyncedProducts.length}`);
console.log(`   Match Rate: ${existingProducts.length > 0 ? Math.round((updatedCount / existingProducts.length) * 100) : 0}%`);

console.log('\n' + '='.repeat(80));
console.log('END OF SYNC REPORT');
console.log('='.repeat(80) + '\n');
    }



    updateSyncStatus(vendorKey, {
      status: 'complete',
      progress: 100,
      phase: 'complete',
      details: 'Sync completed successfully'
    });

    return true;
  } catch (error) {
    console.error('❌ Error in syncListings:', error, {
      vendor: vendor,
      vendorKey: vendorKey
    });
    updateSyncStatus(vendorKey, {
      status: 'error',
      progress: 0,
      phase: 'error',
      details: `Error: ${error.message}`
    });
    throw error;
  }
}

export default function Index() {
  const actionData = useActionData();
  const logos = {
    tourismNZ: logo__tourismNZ,
    eventfinda: logo__eventfinda
  };

   // Check if we received sample data from our debug function
   const showDebugMessage = actionData?.action === 'fetch-sample' && actionData?.success;

  return (
    <Page>
      <BlockStack gap="100">
      {showDebugMessage && (
        <Banner title="Debug Info" tone="info" onDismiss={() => {}}>
          Sample Tourism NZ data has been logged to the console.
        </Banner>
      )}
      </BlockStack>

      <Layout>
        <Layout.Section variant="oneThird">
          <div style={{ 
            marginTop: 'var(--p-space-400)', 
            marginRight: 'var(--p-space-600)', 
            marginBottom: 'var(--p-space-400)', 
            marginLeft: 'var(--p-space-600)' 
          }}>
            <BlockStack gap="200">
              <Text variant="headingMd">Wairarapa API Sync</Text>
              <Text variant="bodyMd" tone="subdued">
              Content is automatically refreshed on a regular schedule. For immediate updates, use <Text as="span" tone="base" fontWeight='bold'>24-Hour Sync</Text> for recent changes or <Text as="span" tone="base" fontWeight='bold'>Historical Sync</Text> for a complete data refresh.
              </Text>
            </BlockStack>
          </div>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
            <SyncManager
              logos={logos}
              actionData={actionData}
              autoDismissDelay={15000}
            />
        </Layout.Section>
      </Layout>

      {/* Add the debug helper component */}
      <DebugHelper />
    </Page>
  );
}

//helper functions

function normalized(str) {
  if (!str) return '';
  
  const result = str
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  
  return result;
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}
