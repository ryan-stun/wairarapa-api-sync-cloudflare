import he from 'he';
import { tourismNzRateLimiter, eventfindaRateLimiter } from './rate-limiter';
const { TOURISM_NZ_BEARER_TOKEN, EVENTFINDA_API_USERNAME, EVENTFINDA_API_PASSWORD } = process.env;


//API handling

const syncStatus = {
  tourismNZ: { status: 'idle', progress: 0, phase: 'idle', details: '' },
  eventfinda: { status: 'idle', progress: 0, phase: 'idle', details: '' }
};

export function updateSyncStatus(listingType, status, phase = null, details = '') {
  if (!syncStatus[listingType]) {
    console.warn(`Unknown listing type: ${listingType}`);
    return;
  }
  
  syncStatus[listingType] = {
    ...syncStatus[listingType],
    ...status,
    phase: phase || status.phase || syncStatus[listingType].phase,
    details: details || status.details || ''
  };
}

export function getSyncStatus(listingType) {
  return syncStatus[listingType] || { status: 'idle', progress: 0, phase: 'idle', details: '' };
}

export function resetSyncStatus(listingType) {
  if (syncStatus[listingType]) {
    syncStatus[listingType] = { status: 'idle', progress: 0, phase: 'idle', details: '' };
  }
}


//tourism NZ functions

async function fetchTourismListings(url) {
  return tourismNzRateLimiter(async () => {
    try {
      console.log('🔍 Fetching Tourism NZ data from:', url);
      
      const requestStartTime = Date.now();
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${TOURISM_NZ_BEARER_TOKEN}`,
        },
      });
      const requestDuration = Date.now() - requestStartTime;

      console.log('📡 API Response Details:', {
        url: url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        duration: `${requestDuration}ms`,
        headers: {
          'content-type': response.headers.get('content-type'),
          'content-length': response.headers.get('content-length'),
          'x-rate-limit-limit': response.headers.get('x-rate-limit-limit'),
          'x-rate-limit-remaining': response.headers.get('x-rate-limit-remaining'),
          'x-rate-limit-reset': response.headers.get('x-rate-limit-reset'),
        }
      });

      const responseBody = await response.text();

      if (!response.ok) {
        console.error(`❌ API request failed:`, {
          status: response.status,
          statusText: response.statusText,
          url: url,
          responsePrefix: responseBody.substring(0, 200) + (responseBody.length > 200 ? '...' : '')
        });
        throw new Error(`Failed to fetch tourism listings: ${response.statusText}`);
      }

      const data = JSON.parse(responseBody);
      
      // Enhanced logging of API response metadata - CHECK FOR BOTH FORMATS
      const totalCount = data.paging?.total_results || data.meta?.total_items || 'Not available';
      const itemsRetrieved = data.meta?.items_retrieved || data.items?.length || 0;
      
      console.log('✅ API request successful:', {
        itemsCount: data.items?.length || 0,
        totalCount: totalCount,
        itemsRetrieved: itemsRetrieved,
        hasModifiedAfter: url.includes('updated_at_gt'),
        duration: `${requestDuration}ms`,
        responseSize: `${Math.round(responseBody.length / 1024)}KB`
      });
      
      // Log pagination info if available
      if (data.paging || data.meta) {
        console.log('📄 Pagination info:', {
          total_results: data.paging?.total_results || data.meta?.total_items,
          items_retrieved: data.meta?.items_retrieved || data.items?.length,
          items_skipped: data.meta?.items_skipped,
        });
      }
      
      // Log the first few items
      if (data.items && data.items.length > 0) {
        const sampleItems = data.items.slice(0, Math.min(3, data.items.length));
        console.log('📑 Sample listings in this batch:', 
          sampleItems.map(item => `${item.unique_id} (${item.nameoflisting.substring(0, 30)}${item.nameoflisting.length > 30 ? '...' : ''})`).join(', ')
        );
      }
      
      return data;
    } catch (error) {
      console.error('❌ Tourism NZ API error:', error.message);
      throw error;
    }
  });
}

async function fetchAllListingsForCategory(admin, tag, matchingTitles, totalCategories, currentCategoryIndex, isInitialSync = false, modifiedAfter = null) {
  console.log(`\n📍 Processing category: ${tag}${isInitialSync ? ' (INITIAL SYNC)' : ' (UPDATE MODE)'}`);
  
  if (!isInitialSync && modifiedAfter) {
    console.log(`🕙 Using modified_after filter: ${modifiedAfter} for category: ${tag}`);
  }
  
  const baseProgress = 20 + (currentCategoryIndex / totalCategories) * 60;
  const progressPerPage = (1 / totalCategories) * 60;
  const expectedTotal = matchingTitles.length;
  
  updateSyncStatus('tourismNZ', 
    { status: 'Fetching', progress: Math.round(baseProgress) },
    'Fetching API Data',
    `Processing category: ${tag}${isInitialSync ? ' (INITIAL SYNC)' : ' (UPDATE MODE)'}`
  );

  let offset = 0;
  const limit = 30;
  let allListings = [];
  let hasMore = true;
  let currentPage = 0;
  let totalProcessed = 0;
  let totalApiListings = 0;
  let apiTotalCount = null; // Track total from API metadata

  while (hasMore) {
    console.log(`\n🔄 Starting page ${currentPage + 1} fetch:`, {
      offset: offset,
      limit: limit,
      totalApiListings: totalApiListings,
      apiTotalCount: apiTotalCount,
      hasMore: hasMore
    });
  
    let url = `https://api.newzealand.com/rest/v1/deliver/listings?level=full&maxrows=${limit}&skip=${offset}&tag=${tag}`;
    
    if (!isInitialSync && modifiedAfter) {
      url += `&updated_at_gt=${modifiedAfter}`;
      console.log(`📅 Using date filter: updated_at_gt=${modifiedAfter}`);
    }
    
    const data = await fetchTourismListings(url);
  
    // Get total count from API metadata on first request
    if (currentPage === 0) {
      apiTotalCount = data.paging?.total_results || data.meta?.total_items;
      if (apiTotalCount) {
        console.log(`📊 API reports total of ${apiTotalCount} listings for category: ${tag}`);
      }
    }
  
    if (!data.items || data.items.length === 0) {
      console.log(`✅ No more items for ${tag} - API returned empty array`);
      hasMore = false;
      continue;
    }
  
    totalProcessed += data.items.length;
    totalApiListings += data.items.length;
    currentPage++;
    
    console.log(`📄 Processing page ${currentPage} with ${data.items.length} items (total processed: ${totalApiListings}${apiTotalCount ? `/${apiTotalCount}` : ''})`);
  
    const newListings = data.items.map(listing => {
      const listingTypes = Array.isArray(listing.listing_types) 
        ? listing.listing_types 
        : (listing.listing_types ? [listing.listing_types] : []);

      return {
        title: listing.nameoflisting,
        description: listing.listing_description,
        summary: listing.listing_summary,
        vendor: 'Tourism New Zealand',
        productType: listing.business_type,
        assets: listing.assets,
        listing_id: listing.unique_id.toString(),
        handle: listing.listing_name_key,
        metafields: [
          { namespace: 'custom', key: 'listing_id', value: listing.unique_id ? listing.unique_id.toString() : '', type: 'single_line_text_field' },
          // { namespace: 'custom', key: 'location', value: listing.cityname || '', type: 'single_line_text_field' },
          { namespace: 'custom', key: 'longitude', value: listing.longitude ? listing.longitude.toString() : '0.0', type: 'number_decimal' },
          { namespace: 'custom', key: 'latitude', value: listing.latitude ? listing.latitude.toString() : '0.0', type: 'number_decimal' },
          { namespace: 'custom', key: 'address', value: `${listing.street || ''}, ${listing.cityname || ''}, ${listing.regionname || ''}`.trim(), type: 'single_line_text_field' },
          { namespace: 'custom', key: 'category', value: JSON.stringify(listing.listing_types || []), type: 'list.single_line_text_field' },
          { namespace: 'custom', key: 'summary', value: (listing.listing_summary || '').replace(/\r?\n|\r/g, ' ').trim(), type: 'single_line_text_field' },
          { namespace: 'custom', key: 'amenities', value: JSON.stringify(listing.amenities || []), type: 'list.single_line_text_field' },
          { namespace: 'custom', key: 'operating_hours', value: JSON.stringify(listing.operational_hours ? [listing.operational_hours] : []), type: 'list.single_line_text_field' },
          { namespace: 'custom', key: 'proximity_to_airport', value: listing.proximity_to_airport || '', type: 'single_line_text_field' },
          { namespace: 'custom', key: 'proximity_to_coach', value: listing.proximity_to_coach || '', type: 'single_line_text_field' },
          { namespace: 'custom', key: 'proximity_to_town', value: listing.proximity_to_town || '', type: 'single_line_text_field' },
          { namespace: 'custom', key: 'website', value: listing.website_link || '', type: 'url' },
          { namespace: 'custom', key: 'email', value: listing.booking_email ? 'mailto:' + listing.booking_email : '', type: 'url' },
          { namespace: 'custom', key: 'booking', value: listing.booking_link || listing.website_link || '', type: 'url' },
          { namespace: 'custom', key: 'phone', value: listing.booking_phone ? 'tel:' + listing.booking_phone : '', type: 'url' },
          { namespace: 'custom', key: 'facebook', value: listing.all_social_profiles?.facebook || '', type: 'url' },
          { namespace: 'custom', key: 'sync_source', value: isInitialSync ? 'initial_sync' : 'update_sync', type: 'single_line_text_field' },
          { namespace: 'custom', key: 'listing_type', value: JSON.stringify(listingTypes || []), type: 'list.single_line_text_field' }
        ].filter(field => field.value !== ''),
      };
    });

    // Log ALL listings from API BEFORE filtering
    console.log(`\n📋 ALL LISTINGS FROM API (Page ${currentPage}, Category: ${tag}):`);
    newListings.forEach((listing, index) => {
      console.log(`  ${index + 1}. "${listing.title}"`);
      console.log(`     Normalized: "${normalizeTitle(listing.title)}"`);
      console.log(`     Type: ${listing.productType}`);
      console.log(`     ID: ${listing.listing_id}`);
    });

    // Always filter by matching titles for Tourism NZ
    const filteredListings = newListings.filter(listing => {
      const normalizedTitle = normalizeTitle(listing.title);
      const exactMatch = matchingTitles.some(matchingTitle => 
        normalizedTitle === matchingTitle
      );
      
      if (exactMatch) {
        console.log(`✓ Exact title match: ${listing.title} (ID: ${listing.listing_id})`);
        return true;
      }
      
      const nearMatches = matchingTitles.filter(matchingTitle => 
        normalizedTitle.includes(matchingTitle) || matchingTitle.includes(normalizedTitle)
      );
      
      if (nearMatches.length > 0) {
        console.log(`⚠️ Near match but not exact (skipping): ${listing.title}`);
        console.log(`  Normalized: "${normalizedTitle}"`);
        console.log(`  Near matches: ${nearMatches.join(', ')}`);
      }
      
      return false;
    });

    console.log(`📊 Filter results: ${filteredListings.length}/${newListings.length} listings matched titles in store`);
    
    allListings.push(...filteredListings);
    
    const progressRatio = Math.min(allListings.length / expectedTotal, 1);
    const totalProgress = Math.min(baseProgress + (progressRatio * progressPerPage), 80);
    
    updateSyncStatus('tourismNZ', 
      { status: 'Fetching', progress: Math.round(totalProgress) },
      'Fetching API Data',
      `Processing ${tag}: Found ${allListings.length}/${expectedTotal} matches (page ${currentPage})`
    );

    console.log('✅ Page processed:', {
      category: tag,
      page: currentPage,
      matchesFound: allListings.length,
      expectedMatches: expectedTotal,
      progress: `${Math.round(totalProgress)}%`
    });

    offset += limit;
    
    // Determine if there are more pages using multiple indicators
    const previousHasMore = hasMore;
    
    if (apiTotalCount) {
      // If we know the total, check if we've fetched everything
      hasMore = totalApiListings < apiTotalCount;
      console.log(`📊 Pagination check (using API total):`, {
        totalApiListings: totalApiListings,
        apiTotalCount: apiTotalCount,
        hasMore: hasMore,
        reasoning: hasMore ? 'Still have items to fetch' : 'Fetched all items'
      });
    } else {
      // Fallback: if we got a full page, assume there might be more
      hasMore = data.items.length === limit;
      console.log(`📊 Pagination check (using page size):`, {
        itemsInThisPage: data.items.length,
        limit: limit,
        hasMore: hasMore,
        reasoning: hasMore ? 'Got full page, assuming more exist' : 'Partial page, assuming end'
      });
    }
    
    if (!hasMore && previousHasMore) {
      console.log(`🛑 Stopping pagination for ${tag}. Final stats:`, {
        totalApiListings: totalApiListings,
        apiTotalCount: apiTotalCount,
        difference: apiTotalCount ? apiTotalCount - totalApiListings : 'N/A'
      });
    }
  }

  console.log(`📊 Category summary for ${tag}:`, {
    pagesProcessed: currentPage,
    totalItemsProcessed: totalProcessed,
    totalFromAPI: apiTotalCount || 'Not reported',
    matchingListingsFound: allListings.length,
    expectedMatches: expectedTotal,
    modifiedAfterFilter: !isInitialSync && modifiedAfter ? `Active (${modifiedAfter})` : 'Not used'
  });

  return allListings;
}

export async function fetchAllTourismListings(admin, isInitialSync = false) {
  console.log('\n🚀 Starting Tourism NZ sync process', isInitialSync ? '(INITIAL SYNC MODE)' : '(UPDATE MODE)');
  
  try {
    // Initialize with proper progress tracking
    updateSyncStatus('tourismNZ', {
      status: 'Initializing',
      progress: 5,
      phase: 'Initializing',
      details: isInitialSync ? 'Starting initial sync of Tourism NZ listings' : 'Preparing to fetch Tourism NZ updates'
    });

    // Get matching titles from store - ALWAYS required for Tourism NZ
    // Unlike Eventfinda, we always filter based on store products
    updateSyncStatus('tourismNZ', {
      status: 'Fetching',
      progress: 10,
      phase: 'Fetching Store Data',
      details: 'Retrieving existing products from store'
    });
    
    const matchingTitles = await getMatchingTitles(admin);
    console.log(`📋 Found ${matchingTitles.length} matching titles to sync`);
    
    if (matchingTitles.length === 0) {
      console.warn('⚠️ No matching titles found in store. Create products with titles that match Tourism NZ listings.');
      updateSyncStatus('tourismNZ', {
        status: 'complete',
        progress: 100,
        phase: 'complete',
        details: 'No matching titles found in store'
      });
      return { listings: [], isInitialSync: isInitialSync, syncTimestamp: new Date().toISOString().split('T')[0] };
    }

    const categories = [
      'wairarapa',
      'upper-hutt',
      'lower-hutt',
      'wellington',
      'paraparaumu',
      //'wellington+custom-transfers',
      //'wellington+guided-sightseeing-tour',
      //'wellington+heritage-attractions+attractions+seals+urban-and-scenic-attractions',
      'pahiatua',
      'kaitoke'
    ];
    
    const totalCategories = categories.length;
    let allListings = [];
    
    // Update progress - starting category fetching
    updateSyncStatus('tourismNZ', {
      status: 'Fetching',
      progress: 20,
      phase: 'Fetching API Data',
      details: `Preparing to fetch ${categories.length} categories`
    });
    
    // Calculate modified_after timestamp for update mode
    let modifiedAfter = null;
    if (!isInitialSync) {
      const fortyEightHoursAgo = new Date();
      fortyEightHoursAgo.setHours(fortyEightHoursAgo.getHours() - 48);
      
      // Format in ISO 8601 which the API supports
      modifiedAfter = fortyEightHoursAgo.toISOString().split('T')[0];
      
      // Log both the JavaScript date object and the formatted string
      console.log(`🕙 48 hours ago:`, fortyEightHoursAgo);
      console.log(`🕙 Using modified_after parameter: ${modifiedAfter}`);
      console.log(`📝 URL parameter will be: updated_at_gt=${encodeURIComponent(modifiedAfter)}`);
    }
    
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      console.log(`\n📍 Processing category ${i + 1}/${categories.length}: ${category}`);
      
      // Calculate progress based on category completion
      const baseProgress = 20; // Start at 20%
      const categoryProgress = baseProgress + ((i / totalCategories) * 60); // Categories take us from 20% to 80%
      
      updateSyncStatus('tourismNZ', 
        { status: 'Fetching', progress: Math.round(categoryProgress) },
        'Fetching API Data',
        `Processing category: ${category} (${i+1}/${totalCategories})`
      );
      
      // Pass in the modifiedAfter parameter based on sync mode
      const categoryListings = await fetchAllListingsForCategory(
        admin, 
        category, 
        matchingTitles,
        categories.length,
        i,
        isInitialSync,
        modifiedAfter
      );
      
      allListings.push(...categoryListings);
      
      // Update progress after each category
      updateSyncStatus('tourismNZ', 
        { status: 'Fetching', progress: Math.round(categoryProgress + (60/totalCategories/2)) },
        'Fetching API Data',
        `Completed category: ${category} (${i+1}/${totalCategories}), Found ${categoryListings.length} listings`
      );
    }

    // Final processing and statistics
    const totalFound = allListings.length;
    console.log('\n✅ Tourism NZ fetch completed:', {
      totalCategories: categories.length,
      totalListings: totalFound,
      listingTypes: [...new Set(allListings.map(l => l.productType))]
    });
    
    // Add a sync source marker similar to Eventfinda
    allListings.forEach(listing => {
      listing.syncSource = isInitialSync ? 'initial_sync' : 'update_sync';
    });
    
    // Count matches vs new listings (should all be matches in Tourism NZ case)
    console.log(`📊 Tourism NZ sync statistics:`, {
      total: totalFound,
      syncMode: isInitialSync ? 'initial_sync' : 'update_sync'
    });

    updateSyncStatus('tourismNZ', 
      { status: 'Processing', progress: 90 },
      'Processing',
      `Preparing ${totalFound} Tourism NZ listings for sync`
    );

    return {
      listings: allListings,
      isInitialSync: isInitialSync,
      syncTimestamp: new Date().toISOString().split('T')[0]
    };
  } catch (error) {
    console.error('❌ Fatal error in fetchAllTourismListings:', error);
    updateSyncStatus('tourismNZ', 
      { status: 'error', progress: 0 },
      'error',
      `Error: ${error.message}`
    );
    throw error;
  }
}


//eventfinda functions

async function fetchEventfindaListings(url) {
  return eventfindaRateLimiter(async () => {
    console.log('🔍 Fetching Eventfinda data from:', url);
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(EVENTFINDA_API_USERNAME + ':' + EVENTFINDA_API_PASSWORD).toString('base64')}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ API request failed:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        throw new Error(`Failed to fetch event listings: ${response.statusText}\n${errorText}`);
      }

      const data = await response.json();
      
      // Extract total count from XML-like structure
      let totalCount = 0;
      if (data['@attributes'] && data['@attributes'].count) {
        totalCount = parseInt(data['@attributes'].count);
      }
      
      // Enhanced logging of API response metadata
      console.log('✅ API request successful:', {
        eventsCount: data.events?.length || 0,
        totalCount: totalCount || 'Not available',
        hasAttributes: !!data['@attributes']
      });
      
      // Log the first few event IDs
      if (data.events && data.events.length > 0) {
        const sampleEvents = data.events.slice(0, Math.min(5, data.events.length));
        console.log('📑 Sample event IDs in this batch:', 
          sampleEvents.map(e => `${e.id} (${e.name.substring(0, 30)}${e.name.length > 30 ? '...' : ''})`).join(', ')
        );
      }
      
      // Return a standardized structure with total count
      return {
        events: data.events || [],
        meta: {
          count: totalCount
        }
      };
    } catch (error) {
      console.error('❌ Eventfinda API error:', error.message);
      throw new Error(`Eventfinda API error: ${error.message}`);
    }
  });
}

function processEventListings(events, locationName, categoryName) {
  return events.map(listing => {
    // Get dates with proper error handling
    let dates = { start_date: '', end_date: '' };
    try {
      if (listing.datetime_summary) {
        const parsedDates = parseDatetimeSummary(listing.datetime_summary);
        if (parsedDates && parsedDates.start_date) {
          dates = parsedDates;
        } else {
          console.warn(`⚠️ Could not parse date from: "${listing.datetime_summary}" for event: ${listing.id}`);
          const today = new Date();
          const formattedDate = today.toISOString().split('T')[0]; // YYYY-MM-DD format
          dates = {
            start_date: formattedDate,
            end_date: formattedDate,
            timing: []
          };
        }
      } else {
        console.warn(`⚠️ Missing datetime_summary for event: ${listing.id}`);
        const today = new Date();
        const formattedDate = today.toISOString().split('T')[0]; // YYYY-MM-DD format
        dates = {
          start_date: formattedDate,
          end_date: formattedDate,
          timing: []
        };
      }
    } catch (error) {
      console.error(`❌ Error parsing dates for event ${listing.id}: ${error.message}`);
      const today = new Date();
      const formattedDate = today.toISOString().split('T')[0]; // YYYY-MM-DD format
      dates = {
        start_date: formattedDate,
        end_date: formattedDate,
        timing: []
      };
    }
    
    // Use the location from the parent mapping (locationName parameter)
    // This ensures consistency with our predefined locations
    let location = locationName;
    
    // Extract venue information (specific location)
    let venue = '';
    let specificLocation = '';
    
    // Try to get venue from location_summary
    if (listing.location_summary) {
      const parts = listing.location_summary.split(',').map(part => part.trim());
      if (parts.length > 0) {
        venue = parts[0]; // First part is typically the venue
      }
    }
    
    // If no venue from location_summary, check if this is a venue itself
    if (!venue && listing.location) {
      if (listing.location.is_venue === '1' || listing.location.is_venue === 1) {
        venue = listing.location.name || '';
      } else if (listing.location.name) {
        // Store the specific location name
        specificLocation = listing.location.name;
      }
    }
    
    // If still no venue, try to extract from address
    if (!venue && listing.address) {
      const addressParts = listing.address.split(',');
      if (addressParts.length > 0) {
        venue = addressParts[0].trim();
      }
    }
    
    // Log what we found
    console.log(`📍 Event ${listing.id}: Parent Location="${location}", Venue="${venue}", Specific Location="${specificLocation}"`);
    
    // Get the specific category for metadata
    const specificCategory = listing.category?.name || 'Unknown';
    
    return {
      title: listing.name,
      description: listing.description,
      summary: he.decode(listing.description),
      tags: listing.is_featured ? `${categoryName}, Featured` : categoryName,
      vendor: 'Eventfinda',
      productType: 'Event',
      images: listing.images,
      listing_id: listing.id.toString(),
      metafields: [
        { namespace: 'custom', key: 'listing_id', value: listing.id ? listing.id.toString() : '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'event_source', value: listing._eventSource || 'unknown', type: 'single_line_text_field' },
        // Use the parent location from our location map
        { namespace: 'custom', key: 'location', value: location, type: 'single_line_text_field' },
        // Add specific location if available
        ...(specificLocation ? [{ namespace: 'custom', key: 'specific_location', value: specificLocation, type: 'single_line_text_field' }] : []),
        // Only add venue if we have one
        ...(venue ? [{ namespace: 'custom', key: 'venue', value: venue, type: 'single_line_text_field' }] : []),
        { namespace: 'custom', key: 'longitude', value: listing.point?.lng ? listing.point.lng.toString() : '0.0', type: 'number_decimal' },
        { namespace: 'custom', key: 'latitude', value: listing.point?.lat ? listing.point.lat.toString() : '0.0', type: 'number_decimal' },
        { namespace: 'custom', key: 'address', value: listing.address || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'location_summary', value: listing.location_summary || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'datetime_summary', value: listing.datetime_summary || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'website', value: listing.url || '', type: 'url' },
        // Use the parent category name from our category map
        { namespace: 'custom', key: 'event_type', value: JSON.stringify([categoryName]), type: 'list.single_line_text_field' },
        // Add specific category if different from the parent category
        ...(specificCategory !== categoryName ? [{ namespace: 'custom', key: 'specific_category', value: specificCategory, type: 'single_line_text_field' }] : []),
        { namespace: 'custom', key: 'start_date', value: dates.start_date, type: 'date' },
        { namespace: 'custom', key: 'end_date', value: dates.end_date, type: 'date' },
        { namespace: 'custom', key: 'description', value: listing.description || '', type: 'multi_line_text_field' },
        { namespace: 'seo', key: 'hidden', value: '1', type: 'number_integer' }
      ].filter(field => field.value !== '')
    };
  });
}

export async function fetchAllEventfindaListings(admin = null, isInitialSync = false) {
  console.log('\n🚀 Starting Eventfinda sync process', isInitialSync ? '(INITIAL SYNC MODE)' : '');

  updateSyncStatus('eventfinda', {
    status: 'Initializing',
    progress: 5,
    phase: 'Initializing',
    details: isInitialSync ? 'Starting initial sync...' : 'Starting daily update...'
  });
  
  
  // Get current timestamp for this sync run (in format expected by API)
  const now = new Date();
  const syncTimestamp = now.toISOString().replace('T', ' ').split('.')[0]; // "YYYY-MM-DD HH:mm:ss"
  console.log(`📅 Current sync timestamp: ${syncTimestamp}`);
  
  // Set lastSyncTimestamp to 24 hours ago (for created_since and modified_since)
  // For initial sync, we use a very old date to get all events
  const oneDayAgo = new Date();
  oneDayAgo.setHours(oneDayAgo.getHours() - 24);
  
  // Use a 10-year-old date for initial sync to get all events
  const tenYearsAgo = new Date();
  tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
  
  const lastSyncTimestamp = isInitialSync 
    ? tenYearsAgo.toISOString().replace('T', ' ').split('.')[0]
    : oneDayAgo.toISOString().replace('T', ' ').split('.')[0];
    
  console.log(`📅 Using last sync timestamp: ${lastSyncTimestamp} ${isInitialSync ? '(10 years ago - INITIAL SYNC)' : '(24 hours ago)'}`);
  
  updateSyncStatus('eventfinda',
    { status: 'Fetching Data', progress: 0 },
    'Fetching Data',
    isInitialSync ? 'Preparing to fetch ALL Eventfinda listings (INITIAL SYNC)' : 'Preparing to fetch recent Eventfinda listings'
  );

  // Key locations we want to search
  const locations = [
    { name: 'Carterton', id: 84 },
    { name: 'Featherston', id: 85 },
    { name: 'Greytown', id: 86 },
    { name: 'Gladstone', id: 40886 },
    { name: 'Martinborough', id: 87 },
    { name: 'Masterton', id: 88 },
    { name: 'Mangatainoka', id: 2709 },
    { name: 'Tauherenikau', id: 33016 },
    { name: 'Wairarapa Coast', id: 36654 }
  ];
  
  // Define specific categories for mapping
  const categories = [
    { name: 'Concerts & Gig Guide', id: 6 },
    { name: 'Exhibitions', id: 11 },
    { name: 'Festivals & Lifestyle', id: 190 },
    { name: 'Performing Arts', id: 1 },
    { name: 'Sports & Outdoors', id: 7 },
    { name: 'Workshops, Conferences & Classes', id: 3 }
  ];
  
  // Create a mapping of category IDs to names for quick lookup
  const categoryMap = {};
  categories.forEach(cat => {
    categoryMap[cat.id] = cat.name;
  });
      
  // Get current date parameters
  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - 30);
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 365);
  
  const formatApiDate = (date) => {
    return date.toISOString().split('T')[0];
  };
  
  const startDate = formatApiDate(pastDate);
  const endDate = formatApiDate(futureDate);

  try {
    // Run initial API call to get a complete list of current events
    // This will be used to identify events that need to be deleted
    console.log('\n🔍 Fetching complete current events list for deletion tracking...');
    updateSyncStatus('eventfinda', {
      status: 'Fetching Data', 
      progress: 10,
      phase: 'Fetching Data',
      details: 'Building complete events list...'
    });
    const allCurrentEvents = await fetchCompleteEventList(locations, startDate, endDate);
    console.log(`✅ Found ${allCurrentEvents.length} total current events across all locations`);

    let recentlyChangedListings = [];
    let processedIds = new Set(); // Track which IDs we've processed to avoid duplicates
    const totalLocations = locations.length;
    const progressIncrement = 100 / totalLocations;
    
    // For initial sync, we'll use all events as our changed listings
    if (isInitialSync) {
      console.log('\n🔄 INITIAL SYNC: Processing all current events as new events...');
      updateSyncStatus('eventfinda', {
        status: 'Processing Data', 
        progress: 30,
        phase: 'Processing Data',
        details: `INITIAL SYNC: Starting to process ${allCurrentEvents.length} events`
      });
      
      // Track progress
      let processedCount = 0;
      const totalEvents = allCurrentEvents.length;
      const baseProgress = 30; // Start at 30%
      const maxProgress = 90; // Go up to 90% during processing
    
      // Process all events with their categories
      for (const event of allCurrentEvents) {
        processedCount++;
        
        // Update progress every 5 events or for first/last
        if (processedCount % 5 === 0 || processedCount === 1 || processedCount === totalEvents) {
          const progress = baseProgress + ((processedCount / totalEvents) * (maxProgress - baseProgress));
          updateSyncStatus('eventfinda', {
            status: 'Processing Data',
            progress: Math.round(progress),
            phase: 'Processing Data',
            details: `Processing event ${processedCount}/${totalEvents}`
          });
        }
        
        // Get the proper parent category name from our mapping
        const categoryName = getParentCategoryName(event, categoryMap);
        
        // Get the proper parent location from our mapping
        const locationName = getParentLocation(event, locations);
        
        // Skip events that don't match our target locations
        const targetLocations = locations.map(loc => loc.name);
        if (!targetLocations.includes(locationName)) {
          console.log(`⏩ Skipping event ${event.id}: "${event.name}" - location "${locationName}" not in our target list`);
          continue;
        }
        
        // Process this individual event with its proper category and location
        const processedEvent = processEventListings([{...event, _eventSource: 'initial_sync'}], locationName, categoryName)[0];
        
        // Only add if not a duplicate
        if (!processedIds.has(processedEvent.listing_id)) {
          recentlyChangedListings.push(processedEvent);
          processedIds.add(processedEvent.listing_id);
        }
      }
      
      console.log(`✅ INITIAL SYNC: Processed ${recentlyChangedListings.length} events`);
    } else {
      // Normal sync mode - process each location to find recently created or modified events
      updateSyncStatus('eventfinda', {
        status: 'Fetching Data', 
        progress: 30,
        phase: 'Fetching Data',
        details: `Starting to fetch recently changed events`
      });

       for (let i = 0; i < locations.length; i++) {
        const location = locations[i];
        // Change base progress to start at 30%
        const baseProgress = 30;
        const progress = baseProgress + (i * ((90 - baseProgress) / totalLocations));
        
        console.log(`\n🔍 Fetching recently changed events for ${location.name} (${i+1}/${totalLocations})`);
        updateSyncStatus('eventfinda',
          { status: 'Fetching Data', progress: Math.round(progress) },
          'Fetching Data',
          `Fetching events for ${location.name}`
        );
        
        // Fetch all pages of recently created or modified events for this location
        let offset = 0;
        const limit = 10; // Respecting the API limit of 10 rows per request
        let hasMore = true;
        let pageCount = 0;
        const maxPages = 20; // Safety limit
        
        while (hasMore && pageCount < maxPages) {
          pageCount++;
          
          // First, try to get only created events (new)
          const createdUrl = `https://api.eventfinda.co.nz/v2/events.json?location=${location.id}&levels=3&rows=${limit}&offset=${offset}&order=date&date_start=${startDate}&date_end=${endDate}&created_since=${lastSyncTimestamp}`;
          console.log(`📃 Fetching new events for ${location.name} (page ${pageCount})...`);
          let newData;
          try {
            newData = await fetchEventfindaListings(createdUrl);
          } catch (error) {
            console.error(`❌ Error fetching new events: ${error.message}`);
            newData = { events: [] };
          }

          // Then, get modified events
          const modifiedUrl = `https://api.eventfinda.co.nz/v2/events.json?location=${location.id}&levels=3&rows=${limit}&offset=${offset}&order=date&date_start=${startDate}&date_end=${endDate}&modified_since=${lastSyncTimestamp}`;
          console.log(`📃 Fetching modified events for ${location.name} (page ${pageCount})...`);
          let modifiedData;
          try {
            modifiedData = await fetchEventfindaListings(modifiedUrl);
          } catch (error) {
            console.error(`❌ Error fetching modified events: ${error.message}`);
            modifiedData = { events: [] };
          }

          // Combine the results, marking each event with its source
          const combinedEvents = [];
          if (newData.events && newData.events.length > 0) {
            newData.events.forEach(event => {
              combinedEvents.push({
                ...event,
                _eventSource: 'created' // Mark as newly created
              });
            });
          }

          if (modifiedData.events && modifiedData.events.length > 0) {
            modifiedData.events.forEach(event => {
              // Only add if not already included from newData
              if (!combinedEvents.some(e => e.id === event.id)) {
                combinedEvents.push({
                  ...event,
                  _eventSource: 'modified' // Mark as modified
                });
              }
            });
          }

          // Use the combined data as our result
          const data = {
            events: combinedEvents,
            meta: {
              count: combinedEvents.length
            }
          };
          
          if (!data.events || data.events.length === 0) {
            console.log(`✅ No more changed events for ${location.name} - reached end of results`);
            hasMore = false;
            continue;
          }
          
          console.log(`✅ Retrieved ${data.events.length} changed events for ${location.name} (page ${pageCount}) - New: ${newData.events?.length || 0}, Modified: ${modifiedData.events?.length || 0}`);
          
          // Process each event with its actual category
          const processedListings = [];
          
          for (const event of data.events) {
            // Get the proper parent category name from our mapping
            const categoryName = getParentCategoryName(event, categoryMap);
            
            // Process this individual event with its proper category
            // We already have the correct parent location (location.name) from our locations map
            const processedEvent = processEventListings([event], location.name, categoryName)[0];
            
            // Only add if not a duplicate
            if (!processedIds.has(processedEvent.listing_id)) {
              processedListings.push(processedEvent);
              processedIds.add(processedEvent.listing_id);
            }
          }
          
          if (processedListings.length > 0) {
            console.log(`✅ Adding ${processedListings.length} changed events from ${location.name} (page ${pageCount})`);
            recentlyChangedListings.push(...processedListings);
          }

          if (pageCount % 3 === 0 || newData.events?.length > 0 || modifiedData.events?.length > 0) {
            const pageProgress = progress + ((pageCount / maxPages) * ((90 - baseProgress) / totalLocations));
            updateSyncStatus('eventfinda',
              { status: 'Fetching Data', progress: Math.round(pageProgress) },
              'Fetching Data',
              `Found ${processedListings.length} events so far (page ${pageCount})`
            );
          }
          
          // Continue to next page if we got a full page from either new or modified
          if ((newData.events?.length || 0) < limit && (modifiedData.events?.length || 0) < limit) {
            hasMore = false;
          } else {
            offset += limit;
          }
          
          // Update progress within this location
          const locationProgress = progress + (progressIncrement * (Math.min(pageCount, maxPages) / maxPages));
          updateSyncStatus('eventfinda',
            { status: 'Fetching Data', progress: Math.round(locationProgress) },
            'Fetching Data',
            `Fetching ${location.name}: Page ${pageCount}`
          );
        }
        
        if (pageCount >= maxPages) {
          console.warn(`⚠️ Reached max page limit (${maxPages}) for ${location.name}. Some events may be missing.`);
        }
        
        // Update progress for completed location
        updateSyncStatus('eventfinda',
          { status: 'Finalizing', progress: 95 },
          'Finalizing',
          `Preparing ${recentlyChangedListings.length} events for sync`
        );
      }
    }
    
    // Final processing
    updateSyncStatus('eventfinda',
      { status: 'Processing Data', progress: 95 },
      'Processing Data',
      'Finalizing event data'
    );
    
    console.log(`\n🔄 Summary of changes detected:`);
    console.log(`📊 Total recently changed events: ${recentlyChangedListings.length}`);
    console.log(`📊 Total current events: ${allCurrentEvents.length}`);
    
    // Analyze location data distribution
    const locationStats = {};
    recentlyChangedListings.forEach(listing => {
      const location = listing.metafields.find(field => field.key === 'location')?.value || 'Unknown';
      locationStats[location] = (locationStats[location] || 0) + 1;
    });
    
    console.log('\n📊 Location distribution in changed events:');
    Object.entries(locationStats).sort((a, b) => b[1] - a[1]).forEach(([location, count]) => {
      console.log(`  ${location}: ${count} events`);
    });

    // Analyze source distribution (created vs modified)
    const sourceStats = {
      created: 0,
      modified: 0,
      initial_sync: 0,
      unknown: 0
    };
    
    recentlyChangedListings.forEach(listing => {
      const sourceField = listing.metafields.find(field => field.key === 'event_source');
      if (sourceField) {
        sourceStats[sourceField.value] = (sourceStats[sourceField.value] || 0) + 1;
      } else {
        sourceStats.unknown++;
      }
    });
    
    console.log('\n📊 Source distribution in changed events:');
    Object.entries(sourceStats).forEach(([source, count]) => {
      if (count > 0) {
        console.log(`  ${source}: ${count} events`);
      }
    });
    
    // Sort by date
    if (recentlyChangedListings.length > 0) {
      console.log('\n📊 Sorting listings by date...');
      recentlyChangedListings.sort((a, b) => {
        const aDate = a.metafields.find(field => field.key === 'start_date')?.value || '';
        const bDate = b.metafields.find(field => field.key === 'start_date')?.value || '';
        return new Date(aDate) - new Date(bDate);
      });
    }
    
    // Make sure all event IDs in allCurrentEvents are strings
    const allCurrentEventIds = allCurrentEvents.map(event => {
      if (!event || !event.id) {
        console.warn('⚠️ Found null/undefined event in allCurrentEvents');
        return '';
      }
      return event.id.toString();
    }).filter(id => id !== '');
    
    // Add all necessary information to the return object
    const result = {
      changedListings: recentlyChangedListings,
      allCurrentListings: allCurrentEventIds,
      syncTimestamp: syncTimestamp,
      isInitialSync: isInitialSync
    };
    
    updateSyncStatus('eventfinda',
      { 
        status: 'complete', 
        progress: 100,
        syncInfo: {
          timestamp: syncTimestamp,
          changedCount: recentlyChangedListings.length,
          totalCount: allCurrentEvents.length,
          isInitialSync: isInitialSync
        }
      },
      'complete',
      isInitialSync 
        ? `INITIAL SYNC: Found ${recentlyChangedListings.length} events out of ${allCurrentEvents.length} total`
        : `Found ${recentlyChangedListings.length} changed events out of ${allCurrentEvents.length} total`
    );
    
    return result;
  } catch (error) {
    console.error('❌ Fatal error in fetchAllEventfindaListings:', error);
    updateSyncStatus('eventfinda',
      { status: 'error', progress: 0 },
      'error',
      `Error: ${error.message}`
    );
    throw error;
  }
}


//helper functions

async function getMatchingTitles(admin) {
  updateSyncStatus('tourismNZ', { status: 'Checking Exisiting Products', progress: 0 }, 'querying', 'Fetching existing products');
  
  const response = await admin.graphql(`#graphql
    query {
      products(first: 250, query: "vendor:Tourism New Zealand") {
        edges {
          node {
            title
            vendor
          }
        }
      }
    }
  `);
  const data = await response.json();

  console.log('\n🔍 Products fetched from Shopify:');
  data.data.products.edges.forEach((edge, index) => {
    console.log(`${index + 1}. "${edge.node.title}" (Vendor: "${edge.node.vendor}")`);
  });

  const titles = data.data.products.edges.map(edge => normalizeTitle(edge.node.title));

  console.log('\n📋 Normalized titles for matching:');
  titles.forEach((title, index) => {
    console.log(`${index + 1}. "${title}"`);
  });
  
  updateSyncStatus('tourismNZ', { status: 'Checking Exisiting Products', progress: 5 }, 'processing', 'Product titles retrieved');
  return titles;
}

function normalizeTitle(title) {
  if (!title) return '';
  
  return title
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')  
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function processImages(dataArray) {
  try {
    const media = [];
    console.log(`🖼️ Starting image processing for ${dataArray.length} items`);
    
    for (const data of dataArray) {
      try {
        let processedImages = [];
        
        // Route to appropriate image processing function based on vendor
        if (data.vendor === 'Tourism New Zealand') {
          processedImages = processGalleryImages(data);
          console.log(`✓ Processed TNZ images for: ${data.title}`, {
            galleryCount: processedImages.length
          });
        } else if (data.vendor === 'Eventfinda') {
          processedImages = processEventImages(data);
          console.log(`✓ Processed Eventfinda images for: ${data.title}`, {
            eventCount: processedImages.length
          });
        }
        
        media.push(...processedImages);
      } catch (error) {
        console.error('Error processing images for item:', {
          title: data.title,
          vendor: data.vendor,
          error: error.message
        });
      }
    }

    console.log(`🎉 Image processing complete. Total media items: ${media.length}`);
    return media;
  } catch (error) {
    console.error('Error in processImages:', error);
    throw error;
  }
}

function processGalleryImages(data) {
  const mediaEntries = [];
  const maxDimension = 4472; // Max dimension supported
  const minDimension = 600;  // Minimum dimension for quality images

  try {
    if (!data.assets?.gallery) {
      console.log(`⚠️ No gallery assets found for: ${data.title}`);
      return mediaEntries;
    }
    
    console.log(`🖼️ Processing gallery with ${Object.keys(data.assets.gallery).length} items for: ${data.title}`);
    
    // Track all viable images to select best ones
    const viableImages = [];
    
    for (const key in data.assets.gallery) {
      const galleryAsset = data.assets.gallery[key];
      if (!galleryAsset?.instances || !Array.isArray(galleryAsset.instances)) {
        console.log(`⚠️ No valid instances array for gallery asset key: ${key}`);
        continue;
      }

      try {
        // Log found instances
        console.log(`📊 Found ${galleryAsset.instances.length} instances for asset ${key}`);
        
        // Check if this appears to be a video thumbnail
        const isLikelyVideo = galleryAsset.caption?.toLowerCase().includes('video') || 
                             galleryAsset.label?.toLowerCase().includes('video');
        
        if (isLikelyVideo) {
          console.log(`⚠️ Skipping likely video thumbnail: ${galleryAsset.caption || key}`);
          continue;
        }
        
        // Find the best image instance - prefer "large" format
        const filteredInstances = galleryAsset.instances.filter(instance => 
          instance &&
          instance.url &&
          !instance.url.includes('media-icons') &&
          instance.width <= maxDimension &&
          instance.height <= maxDimension &&
          instance.width >= minDimension &&
          instance.height >= minDimension
        );
        
        if (filteredInstances.length === 0) {
          console.log(`⚠️ No suitable instances found for gallery asset ${key}`);
          continue;
        }
        
        // Sort instances by preference:
        // 1. First prefer "large" format for consistent quality
        // 2. Then prefer larger width for better quality
        // 3. Finally, prefer higher resolution overall (area)
        const sortedInstances = filteredInstances.sort((a, b) => {
          // Prioritize "large" format
          if (a.format === "large" && b.format !== "large") return -1;
          if (a.format !== "large" && b.format === "large") return 1;
          
          // Then prioritize by width
          if (a.width !== b.width) return b.width - a.width;
          
          // Then by total resolution
          return (b.width * b.height) - (a.width * a.height);
        });
        
        // Pick the best instance
        const bestInstance = sortedInstances[0];
        
        // Add to viable images with metadata
        viableImages.push({
          instance: bestInstance,
          caption: galleryAsset.caption || data.title || '',
          order: galleryAsset.order || 999, // Respect ordering if available
          isPortrait: bestInstance.height > bestInstance.width,
          assetId: key,
          ratio: bestInstance.width / bestInstance.height
        });
        
      } catch (error) {
        console.error(`❌ Error processing gallery asset ${key}:`, error);
      }
    }
    
    // Sort viable images - prioritize order field, then landscape vs portrait
    // as needed for your slider layout
    viableImages.sort((a, b) => {
      // First by explicit order if available
      if (a.order !== b.order) return a.order - b.order;
      
      // If you need specific layout rules (e.g., prefer landscape for first image),
      // you can add that logic here
      
      // Default: sort by higher resolution
      const aResolution = a.instance.width * a.instance.height;
      const bResolution = b.instance.width * b.instance.height;
      return bResolution - aResolution;
    });
    
    // Log image selection summary
    console.log(`✅ Selected ${viableImages.length} viable images from gallery:
      - Landscape: ${viableImages.filter(img => !img.isPortrait).length}
      - Portrait: ${viableImages.filter(img => img.isPortrait).length}`);
    
    // Convert viable images to media entries for Shopify
    mediaEntries.push(...viableImages.map(img => ({
      originalSource: img.instance.url,
      alt: img.caption,
      mediaContentType: 'IMAGE'
    })));
    
    console.log(`📊 Total media entries for Shopify: ${mediaEntries.length}`);
    return mediaEntries;
  } catch (error) {
    console.error(`❌ Error in processGalleryImages for ${data.title}:`, error);
    return [];
  }
}

function processEventImages(data) {
  const fallbackImage = {
    originalSource: 'https://cdn.shopify.com/s/files/1/0836/4726/7113/t/20/assets/whats-on_fallback.jpg',
    alt: data.title || '',
    mediaContentType: 'IMAGE'
  };

  try {
    // If no images array, return fallback
    if (!data.images?.images?.length) {
      return [fallbackImage];
    }

    for (const image of data.images.images) {
      if (!image?.transforms?.transforms) {
        continue;
      }

      const transforms = image.transforms.transforms;
      const preferredImage = transforms.find(transform => 
        transform?.transformation_id === 35
      ) || transforms.find(transform => 
        transform?.transformation_id === 7
      );

      if (preferredImage?.url) {
        return [{
          originalSource: preferredImage.url,
          alt: data.title || '',
          mediaContentType: 'IMAGE'
        }];
      }
    }

    // Return fallback if no valid images found
    return [fallbackImage];
  } catch (error) {
    console.error("Error in processEventImages:", error);
    return [fallbackImage];
  }
}

function parseDatetimeSummary(datetimeSummary) {
  try {
    // Handle edge cases
    if (!datetimeSummary || typeof datetimeSummary !== 'string') {
      console.warn(`⚠️ Invalid datetime_summary: ${datetimeSummary}`);
      return null;
    }
    
    const normalizedSummary = datetimeSummary.replace(/\s+/g, ' ').trim();
    
    // Return default dates for empty strings
    if (!normalizedSummary) {
      console.warn(`⚠️ Empty datetime_summary after normalization`);
      return null;
    }
    
    const hasSeparator = normalizedSummary.includes(' - ');
    let startPart, endPart;
    
    if (hasSeparator) {
      [startPart, endPart] = normalizedSummary.split(' - ');
    } else {
      startPart = endPart = normalizedSummary;
    }
    
    const parseDate = (datePart, isStartDate = false, endYear = '') => {
      const months = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
        'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
        'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
      };
      
      // Remove day of week prefix if present
      const cleanDate = datePart.replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/, '').trim();
      
      // Split the date string into components
      const parts = cleanDate.split(' ').filter(part => part !== '');
      
      // Check if we have at least day and month
      if (parts.length < 2) {
        console.warn(`⚠️ Incomplete date format: "${datePart}" (cleaned: "${cleanDate}")`);
        return null;
      }
      
      // Check if the first part is a number (the day)
      const day = isNaN(parseInt(parts[0])) ? '01' : parts[0].padStart(2, '0');
      
      // Check if the second part is a valid month
      if (!months[parts[1]]) {
        console.warn(`⚠️ Unknown month format: "${parts[1]}" in "${datePart}"`);
        return null;
      }
      
      let year;
      if (parts[2]) {
        year = parts[2];
      } else if (isStartDate && endYear) {
        const currentYear = new Date().getFullYear();
        const endYearNum = parseInt(endYear);
        
        if (endYearNum > currentYear) {
          year = currentYear.toString();
        } else {
          year = endYear;
        }
      } else if (endYear) {
        year = endYear;
      } else {
        year = new Date().getFullYear().toString();
      }
      
      return `${year}-${months[parts[1]]}-${day}`;
    };
    
    // Try to extract year from end part if it exists
    const yearMatch = endPart.match(/\d{4}/);
    const endYear = yearMatch ? yearMatch[0] : '';
    
    // Parse start and end dates
    const startDate = parseDate(startPart, true, endYear);
    const endDate = parseDate(endPart, false, endYear);
    
    // If either date failed to parse, use current date as fallback
    if (!startDate || !endDate) {
      console.warn(`⚠️ Failed to parse one or both dates: start="${startPart}", end="${endPart}"`);
      const today = new Date().toISOString().split('T')[0];
      return {
        start_date: today,
        end_date: today,
        timing: []
      };
    }

    // Calculate timing categories if both dates are valid
    const timing = calculateTimingCategories(startDate, endDate);
    
    return {
      start_date: startDate,
      end_date: endDate,
      timing
    };
  } catch (error) {
    console.error(`❌ Error parsing datetime summary: ${error.message}`, "Input was:", datetimeSummary);
    return null;
  }
}

function calculateTimingCategories(startDate, endDate) {
  const categories = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);
  
  const weekendStart = new Date(today);
  weekendStart.setDate(weekendStart.getDate() + (6 - weekendStart.getDay()));
  const weekendEnd = new Date(weekendStart);
  weekendEnd.setDate(weekendEnd.getDate() + 1); 
  
  const eventStart = new Date(startDate);
  const eventEnd = new Date(endDate);

  if (eventStart <= today && eventEnd >= today) {
    categories.push('Today');
  }

  if (eventStart <= nextWeek && eventEnd >= today) {
    categories.push('This Week');
  }

  if (eventStart <= weekendEnd && eventEnd >= weekendStart) {
    categories.push('This Weekend');
  }

  return categories;
}

async function fetchCompleteEventList(locations, startDate, endDate) {
  let allEvents = [];
  let processedIds = new Set();

  // For progress tracking
  let completedLocations = 0;
  const totalLocations = locations.length;
  const baseProgress = 10;
  const maxProgress = 30;

  for (const location of locations) {
    let offset = 0;
    const limit = 10;
    let hasMore = true;
    let pageCount = 0;

    // Increased slightly as a safety ceiling.
    // Actual pagination is controlled by API total count.
    const maxPages = 100;

    // Store the total number of matching results reported by Eventfinda
    let totalCount = null;

    console.log(`📋 Fetching complete event list for ${location.name}...`);

    const currentProgress =
      baseProgress +
      ((completedLocations / totalLocations) * (maxProgress - baseProgress));

    updateSyncStatus('eventfinda', {
      status: 'Fetching Data',
      progress: Math.round(currentProgress),
      phase: 'Fetching Data',
      details: `Fetching events for ${location.name} (${completedLocations + 1}/${totalLocations})`
    });

    while (hasMore && pageCount < maxPages) {
      pageCount++;

      const url =
        `https://api.eventfinda.co.nz/v2/events.json` +
        `?location=${location.id}` +
        `&levels=3` +
        `&rows=${limit}` +
        `&offset=${offset}` +
        `&order=date` +
        `&date_start=${startDate}` +
        `&date_end=${endDate}`;

      try {
        const data = await fetchEventfindaListings(url);

        const events = data.events || [];

        // Get the total result count from Eventfinda
        if (totalCount === null) {
          totalCount = Number(data.meta?.count || 0);

          console.log(
            `📊 ${location.name}: Eventfinda reports ${totalCount} matching events`
          );
        }

        console.log(
          `📄 ${location.name}: page ${pageCount}, offset ${offset}, ` +
          `received ${events.length}, total ${totalCount}`
        );

        if (events.length === 0) {
          console.warn(
            `⚠️ ${location.name}: No events returned at offset ${offset}, ` +
            `but API reports ${totalCount} total results. Continuing pagination.`
          );
        }

        // Add only unique events
        events.forEach(event => {
          if (!processedIds.has(event.id)) {
            allEvents.push(event);
            processedIds.add(event.id);
          }
        });

        // Update progress for each page within a location
        const pageProgress =
          currentProgress +
          ((pageCount / maxPages) *
            ((maxProgress - baseProgress) / totalLocations));

        updateSyncStatus('eventfinda', {
          status: 'Fetching Data',
          progress: Math.round(pageProgress),
          phase: 'Fetching Data',
          details: `Fetching ${location.name}: Page ${pageCount} (${allEvents.length} events)`
        });

        /*
         * IMPORTANT:
         * Advance using the API's result set,
         * not events.length.
         */
        offset += limit;

        /*
         * Stop once we've paginated through the number
         * of results Eventfinda says exist.
         */
        if (offset >= totalCount) {
          hasMore = false;

          console.log(
            `✅ Finished ${location.name}: reached ${offset}/${totalCount}`
          );
        }

      } catch (error) {
        console.error(
          `❌ Error fetching complete list for ${location.name}:`,
          error.message
        );

        break;
      }
    }

    if (pageCount >= maxPages && hasMore) {
      console.warn(
        `⚠️ Reached max page limit (${maxPages}) for ${location.name}. ` +
        `Some events may be missing.`
      );
    }

    completedLocations++;
  }

  console.log(
    `📋 Complete event list contains ${allEvents.length} unique events`
  );

  updateSyncStatus('eventfinda', {
    status: 'Processing Data',
    progress: 30,
    phase: 'Processing Data',
    details: `Found ${allEvents.length} total events across all locations`
  });

  return allEvents;
}

function getParentCategoryName(event, categoryMap) {
  // Default category if nothing else is found
  let categoryName = "Other";
  
  if (!event.category) {
    return categoryName;
  }
  
  // Try to find a parent category that matches our mapping
  if (event.category.parents && 
      event.category.parents.parents && 
      Array.isArray(event.category.parents.parents)) {
      
    // Loop through all parent categories to find a match in our map
    for (const parentCategory of event.category.parents.parents) {
      // Check if this parent category ID is in our map
      if (parentCategory.id && categoryMap[parentCategory.id]) {
        return categoryMap[parentCategory.id];
      }
      
      // Check if this parent name is in our map values
      const categoryEntry = Object.entries(categoryMap).find(([_, name]) => name === parentCategory.name);
      if (categoryEntry) {
        return categoryEntry[1]; // Return the mapped name
      }
    }
    
    // If no match in the map, use the first parent's name if available
    if (event.category.parents.parents.length > 0 && event.category.parents.parents[0].name) {
      return event.category.parents.parents[0].name;
    }
  }
  
  // If no parent match, try to match the category itself
  if (event.category.id && categoryMap[event.category.id]) {
    return categoryMap[event.category.id];
  }
  
  // Last resort: use the category name if available
  if (event.category.name) {
    return event.category.name;
  }
  
  return categoryName;
}

function getParentLocation(event, locationMap) {
  // Default location if nothing is found
  let locationName = "Unknown";
  
  // First check if the location itself has an ID that matches our mapping
  if (event.location && event.location.id) {
    // Try to find a direct match in our locations map
    const locationMatch = locationMap.find(loc => loc.id === event.location.id);
    if (locationMatch) {
      return locationMatch.name;
    }
  }
  
  // Next, try to find a parent location in our map
  if (event.location && 
      event.location.parents && 
      event.location.parents.parents && 
      Array.isArray(event.location.parents.parents)) {
    
    // Loop through parent locations to find a match
    for (const parentLocation of event.location.parents.parents) {
      // Try to find a match by ID
      if (parentLocation.id) {
        const locationMatch = locationMap.find(loc => loc.id === parentLocation.id);
        if (locationMatch) {
          return locationMatch.name;
        }
      }
      
      // Try to find a match by name
      if (parentLocation.name) {
        const locationMatch = locationMap.find(loc => loc.name === parentLocation.name);
        if (locationMatch) {
          return locationMatch.name;
        }
      }
    }
    
    // If no match in the map but we have parent locations, use the first one
    if (event.location.parents.parents.length > 0 && event.location.parents.parents[0].name) {
      // Check if it's one of our target areas - in the Wairarapa area
      // This helps ensure we only handle events in our target regions
      const parentName = event.location.parents.parents[0].name;
      const wairerapaParents = ["Carterton", "Featherston", "Greytown", "Martinborough", 
                              "Masterton", "Mangatainoka", "Tauherenikau", "Wairarapa Coast"];
      
      if (wairerapaParents.includes(parentName)) {
        return parentName;
      }
    }
  }
  
  // Last resort: use location name if available
  if (event.location && event.location.name) {
    return event.location.name;
  }
  
  return locationName;
}

function mapTagsToFilterOptions(tags) {
  const filterOptionsMap = {
    "Adventure": [
      "Adventure",
      "Air activities",
      "Kayaking",
      "Mountain biking",
      "Rafting",
      "Scenic flights",
      "Water activities"
    ],
    "Activities": [
      "Activities",
      "Activities & Day Trips",
      "Attractions",
      "Land Activities",
      "Sports",
      "Theme & leisure parks",
      "Urban attractions",
      "Farms",
      "Wineries",
      "Breweries",
      "Lunch",
    ],
    "All Trails": [
      "All Trails",
      "Cycling & Mountain Biking",
      "Walking & hiking"
    ],
    "Art & Museums": [
      "Art & Museums",
      "Arts & crafts",
      "Arts, Culture and Heritage",
      "Galleries",
      "Heritage attractions",
      "Maori Cultural Attractions",
      "Museums"
    ],
    "Cycling": [
      "Bike Hire",
      "Cycle Shuttles",
      "Cycling & Mountain Biking",
      "Cycling",
      "Mountain biking"
    ],
    "Cinema": [
      "Cinema"
    ],
    "Family Friendly": [
      "Family Friendly",
      "Theme & leisure parks",
      "Wildlife Encounters",
      "Zoos & wildlife parks"
    ],
    "Gardens": [
      "Gardens"
    ],
    "Golf": [
      "Golf"
    ],
    "Guided Tour": [
      "Cruise Ships",
      "Guided Tour",
      "Guided Tours",
      "Multi-Day Tours & Packages"
    ],
    "Shopping": [
      "Shopping"
    ],
    "Stargazing": [
      "Stargazing"
    ],
    "Wellness": [
      "Wellness"
    ],
    "Wildlife": [
      "Bird watching",
      "Seals",
      "Wildlife",
      "Wildlife Encounters",
      "Zoos & wildlife parks"
    ],
    "Transport": [
      "Air transport",
      "Airport shuttles",
      "Bus & coach transport",
      "Courtesy Transport",
      "Custom transfers",
      "Transport"
    ]
  };

  const attractionsMapping = {
    "Attractions": ["Activities"],
    "Urban attractions": ["Activities"]
  };

  if (!tags || !Array.isArray(tags)) {
    return [];
  }

  const matchedFilterOptions = new Set();
  
  const hasSports = tags.includes("Sports");
  const hasCycling = tags.some(tag => 
    tag === "Cycling & Mountain Biking" || 
    tag === "Cycling" || 
    tag === "Mountain biking" ||
    tag === "Bike Hire"
  );
  const hasGolf = tags.includes("Golf");
  
  if (hasSports) {
    if (hasCycling) {
      matchedFilterOptions.add("Cycling");
    } else if (hasGolf) {
      matchedFilterOptions.add("Golf");
    } else {
      matchedFilterOptions.add("Activities");
    }
  }

  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    
    if (tag === "Sports") continue;
    
    if (attractionsMapping[tag]) {
      attractionsMapping[tag].forEach(filterOption => matchedFilterOptions.add(filterOption));
      continue;
    }
    
    for (const [filterOption, variations] of Object.entries(filterOptionsMap)) {
      for (const variation of variations) {
        if (tag === variation || 
            tag.toLowerCase() === variation.toLowerCase()) {
          matchedFilterOptions.add(filterOption);
          break; 
        }
      }
    }
  }
  
  if (matchedFilterOptions.size === 0) {
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag === "Sports") continue;
      
      const normalizedTag = tag.toLowerCase().trim();
      
      for (const [filterOption, variations] of Object.entries(filterOptionsMap)) {
        for (const variation of variations) {
          const normalizedVariation = variation.toLowerCase().trim();
          
          if (normalizedTag.includes(normalizedVariation) || normalizedVariation.includes(normalizedTag)) {
            matchedFilterOptions.add(filterOption);
            break;
          }
        }
      }
    }
  }

  return Array.from(matchedFilterOptions);
}

export async function fetchTourismBasicInfo(admin) {
  console.log('🔄 Fetching all Tourism NZ listings (titles and tags only)...');
  
  try {
    const matchingTitles = await getMatchingTitles(admin);
    console.log(`📋 Found ${matchingTitles.length} matching titles to sync`);
    
    const expectedTotal = matchingTitles.length;

    // Standard categories used in the full sync
    const categories = [
      'wairarapa',
      'upper-hutt',
      'lower-hutt',
      'wellington',
      'paraparaumu',
      //'wellington+custom-transfers',
      //'wellington+guided-sightseeing-tour',
      //'wellington+heritage-attractions+attractions+seals+urban-and-scenic-attractions',
      'pahiatua',
      'kaitoke'
    ];
    
    const allListings = [];
    
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      console.log(`\n📍 Processing category ${i + 1}/${categories.length}: ${category}`);

      let offset = 0;
      const limit = 20;
      let hasMore = true;
      let currentPage = 0;
      let totalProcessed = 0;
      
      while (hasMore) {
        const url = `https://api.newzealand.com/rest/v1/deliver/listings?level=full&maxrows=${limit}&skip=${offset}&tag=${category}`;
        
        const data = await fetchTourismListings(url);
        
        if (!data.items || data.items.length === 0) {
          hasMore = false;
          continue;
        }

        totalProcessed += data.items.length;
        currentPage++;
        
        // Simplified mapping - just title, ID and tags
        const simplifiedListings = data.items.map(listing => {
          const filterOptions = listing.business_type.toLowerCase() === 'accommodation' 
          ? [] 
          : mapTagsToFilterOptions(listing.tags);
          
          return {
          title: listing.nameoflisting,
          productType: listing.business_type,
          tags: JSON.stringify(listing.tags),
          filters: JSON.stringify(filterOptions)
        };
      });

      
         const filteredListings = simplifiedListings.filter(listing => {
      const normalizedTitle = normalizeTitle(listing.title);
      // Require exact match of normalized titles
      const exactMatch = matchingTitles.some(matchingTitle => 
        normalizedTitle === matchingTitle
      );
      
      if (exactMatch) {
        console.log(`✓ Exact title match: ${listing.title}, Type: ${listing.productType}, Tags: ${listing.tags}, Filters: ${listing.filters}`);
        return true;
      }
      
      // Log near-matches for debugging
      const nearMatches = matchingTitles.filter(matchingTitle => 
        normalizedTitle.includes(matchingTitle) || matchingTitle.includes(normalizedTitle)
      );
      
      if (nearMatches.length > 0) {
        console.log(`⚠️ Near match but not exact (skipping): ${listing.title}`);
        console.log(`  Normalized: "${normalizedTitle}"`);
        console.log(`  Near matches: ${nearMatches.join(', ')}`);
      }
      
      return false;
    });
        
        allListings.push(...filteredListings);

        if (allListings.length >= expectedTotal) {
          console.log(`📍 Found all ${expectedTotal} expected matches`);
          break;
        }
        
        offset += limit;
        hasMore = data.items.length === limit;
      }
    }
    
    console.log(`✅ Total listings: ${allListings.length}`);

    console.log(JSON.stringify(allListings, null, 2));
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
}
