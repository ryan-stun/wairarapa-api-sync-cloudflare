import { json } from "@remix-run/cloudflare";
import { getSyncStatus } from '../utils/api';
import { authenticate } from '../shopify.server';

export async function loader({ request }) {
  try {
        await authenticate.admin(request);
    
    const url = new URL(request.url);
    const listingType = url.searchParams.get('listingType');
    
    if (!listingType) {
      return json({ 
        error: 'Missing listingType parameter',
        status: 'error',
        progress: 0
      }, { status: 400 });
    }

    if (!['tourismNZ', 'eventfinda'].includes(listingType)) {
      return json({ 
        error: 'Invalid listingType parameter',
        status: 'error',
        progress: 0
      }, { status: 400 });
    }

    const status = getSyncStatus(listingType);
    return json(status);
    
  } catch (error) {
    console.error('Error in sync status loader:', error);
    return json({ 
      error: 'Failed to fetch sync status',
      status: 'error',
      progress: 0
    }, { status: 500 });
  }
}