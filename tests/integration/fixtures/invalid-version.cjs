'use strict';

module.exports = {
  apiVersion: 2,
  name: 'invalid-version',
  resolveProject() {
    return { apiVersion: 1, integration: 'invalid-version', projectRoot: '.' };
  },
};
