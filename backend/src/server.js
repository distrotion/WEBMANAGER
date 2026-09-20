'use strict';
// DELIBERATELY BROKEN release for the self-update rollback test (mission 2, 3.1).
// Never merge. The health gate must reject this and roll back.
throw new Error('selfupdate rollback test: this release must not start');
