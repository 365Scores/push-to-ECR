const CORE = require('@actions/core');
const YAML = require('yaml');
const fs = require('fs');
const { exec } = require("child_process");
const { ECRClient, BatchDeleteImageCommand } = require("@aws-sdk/client-ecr");

// inputs
const env_key = CORE.getInput('env-key');
const local_image = CORE.getInput('local-image');

async function pushToECR(target) {
  try {
	
	var registry = target['ecr-registry'];
	var repository = target['ecr-repository'];
	var tag = target['ecr-tag'];
	var forcePush = target['force-push'];
	var continueOnError = target['continue-on-error'];
	var error = false;
	
	if (!registry) {
		CORE.setFailed(`ECR push target is missing ecr-registry`);
		error = true;
	}
	if (!repository) {
		CORE.setFailed(`ECR push target is missing ecr-repository`);
		error = true;
	}
	if (!tag) {
		CORE.setFailed(`ECR push target is missing ecr-tag`);
		error = true;
	}
	if (forcePush !== undefined && forcePush !== true && forcePush !== false) {
		CORE.setFailed(`ECR push target has invalid value for force-push. Either omit this property or set it to one of the valid values: [true, false]`);
		error = true;
	}
	if (continueOnError !== undefined && continueOnError !== true && continueOnError !== false) {
		CORE.setFailed(`ECR push target has invalid value for continue-on-error. Either omit this property or set it to one of the valid values: [true, false]`);
		error = true;
	}
	if (error) { return; }
	
	var newImage = `${registry}/${repository}:${tag}`;
	
	try {
		var shellResult = await execAsync(`docker image tag ${local_image} ${newImage}`);
		console.log(`tag ${newImage}: success`);
	}
	catch (error) {
		errorMessage = `tag ${newImage}: ${error}`;
		if (continueOnError) { console.error(errorMessage); }
		else { CORE.setFailed(errorMessage); }
		return;
	}
	
	if (forcePush) {
		var ecr_client = new ECRClient();
		const ecr_response = await ecr_client.send(new BatchDeleteImageCommand({
			repositoryName: repository,
			imageIds: [{ imageTag: tag }]
		}));
		if (ecr_response && ecr_response.failures && ecr_response.failures.length > 0) {
			var error = false;
			ecr_response.failures.forEach(function(failure) {
				if (failure.failureCode != 'ImageNotFound') {
					error = true;
				}
			});
			if (error) {
				CORE.setFailed(`delete existing ECR tag ${newImage}: ${JSON.stringify(ecr_response, null, 2)}`);
				return;
			}
		}
		console.log(`ECR delete tag ${newImage} - Success`);
		//console.log(ecr_response);
	}
	
	try {
		var shellResult = await execAsync(`docker push ${newImage}`);
		console.log(`push ${newImage}: success`);
	}
	catch (error) {
		errorMessage = `push ${newImage}: ${error}`;
		if (continueOnError) { console.error(errorMessage); }
		else { CORE.setFailed(errorMessage); }
		return;
	}
  }
  catch (error) {
    CORE.setFailed(error);
  }
}

function execAsync(command) {
    return new Promise((resolve, reject) => {	
		exec(command, (error, stdout, stderr) => {
			var errorMessage;
			if (error) { reject(error); }
			else if (stderr) { reject(stderr); }
			else { resolve(stdout); }
		});
    });
}

async function main() {
  try {
	
    //console.log(`env_key ${env_key}, spot_io_token ${spot_io_token}`);
	
	const file = fs.readFileSync('.automation/deployment_envs.yaml', 'utf8');
	var yamlObj = YAML.parse(file);
	var envs = yamlObj['envs'];
	var requested_env = envs[env_key];
	if (!requested_env) {
		CORE.setFailed(`requested env (${env_key}) is missing`);
		return;
	}
	
	var publishTargets = requested_env['publish-to'];
	if (publishTargets && publishTargets.length > 0) {
		console.log(`${env_key} has ${publishTargets.length} ECR publish targets`);
		publishTargets.forEach(pushToECR);
	}
  }
  catch (error) {
    CORE.setFailed(error.message);
  }
}

main();