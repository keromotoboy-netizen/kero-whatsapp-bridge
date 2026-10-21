import {createArchivedGroupCleanup} from './archived-group-cleanup.mjs';
import {readArchivedGroupState} from './archive-state-reader.mjs';

// Keep the production dependency wiring testable: no cached-CRM fallback.
export function createCrmArchivedCleanup({getConnection,readState,sdk}){
 return createArchivedGroupCleanup({getConnection,readState,refresh:connection=>readArchivedGroupState(connection,sdk)});
}
