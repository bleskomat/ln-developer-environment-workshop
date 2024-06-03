before(function() {
	this.helpers = require('../helpers');
});

before(function() {
	return this.helpers.prepareTmpDir();
});

after(function() {
	return this.helpers.removeTmpDir();
});
