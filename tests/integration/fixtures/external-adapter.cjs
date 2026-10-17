'use strict';

module.exports = {
  apiVersion: 1,
  name: 'external-fixture',
  resolveProject(context) {
    return {
      apiVersion: 1,
      integration: 'external-fixture',
      projectRoot: context.projectRoot,
    };
  },
};
