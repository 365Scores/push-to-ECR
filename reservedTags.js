const CORE = require('@actions/core');

async function readReservedTag(reserved_tag) {
	switch (reserved_tag) {
		case "app-version":
			const app_version = CORE.getInput('app-version');
			if (app_version)
				return app_version;
			else
				throw `Action input 'app-version' is (${app_version})`;

		default:
			throw `Reserved tag ${reserved_tag} is not recognized. Make sure you only use reserved tags listed in the README.md`;
	}
}

exports.readReservedTag = readReservedTag;
