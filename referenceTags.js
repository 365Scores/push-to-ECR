const CORE = require('@actions/core');

const extra_tags = readExtraTags();

function readExtraTags() {
	const input = CORE.getInput('extra-tags');
	let obj = {};
	if (input) {
		const KVPs = input.split(',');
		KVPs.forEach(function (kvp) {
			const parts = kvp.split('=');
			if (parts.length != 2) {
				throw 'malformed input: extra-tags.'
			}
			const key = parts[0];
			const value = parts[1];
			if (key in obj) {
				throw `extra-tags has duplicate key: ${key}.`
			}
			obj[key] = value;
		});
	}
	return obj;
}

// read tag value by reference to extra-tags or reserved tags
function readReferenceTag(tag, target) {

    // reserved tags
    if (tag.startsWith('$$$')) {
        const reserved_tag = tag.substring(3);
        try {
            tag = readReservedTag(reserved_tag);
        } catch (reserved_tags_error) {
            const errorMessage = `Failed to process reserved tag ${reserved_tag} of target ${JSON.stringify(target, null, 2)}. Error:\n${reserved_tags_error}`;
            throw errorMessage;
        }
    }

    // extra tags
    else if (tag.startsWith('$$')) {
        const input_tag = extra_tags[tag.substring(2)];
        if (input_tag) {
            tag = input_tag;
        }
        else {
            const errorMessage = `warning: ECR push target is missing ecr-tag. extra-tags is missing tag ${tag.substring(2)}.`;
            throw errorMessage;
        }
    }
    return tag;
}

function readReservedTag(reserved_tag) {
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

exports.readReferenceTag = readReferenceTag;
exports.readReservedTag = readReservedTag;
