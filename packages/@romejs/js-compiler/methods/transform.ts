/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {Program} from '@romejs/js-ast';
import {PartialDiagnostics, DiagnosticSuppressions} from '@romejs/diagnostics';
import {TransformRequest, TransformVisitors} from '../types';
import {program} from '@romejs/js-ast';
import {stageTransforms, stageOrder, hookVisitors} from '../transforms/index';
import {Cache} from '@romejs/js-compiler';
import Context from '../lib/Context';
import {extractSuppressionsFromProgram} from '../suppressions';

type TransformResult = {
  ast: Program;
  suppressions: DiagnosticSuppressions;
  diagnostics: PartialDiagnostics;
  cacheDependencies: Array<string>;
};

const transformCaches: Array<Cache<TransformResult>> = stageOrder.map(() =>
  new Cache()
);

export default async function transform(
  req: TransformRequest,
): Promise<TransformResult> {
  const stage = req.stage === undefined ? 'compile' : req.stage;

  const {options, project} = req;
  let ast: Program = req.ast;

  const cacheQuery = Cache.buildQuery(req);

  const stageNo = stageOrder.indexOf(stage);

  // Check this exact stage cache
  const stageCache = transformCaches[stageNo];
  const cached: undefined | TransformResult = stageCache.get(cacheQuery);
  if (cached !== undefined) {
    return cached;
  }

  let prevStageDiagnostics: PartialDiagnostics = [];
  let prevStageCacheDeps: Array<string> = [];

  // Run the previous stage
  if (stageNo > 0) {
    const prevStage = await transform({...req, stage: stageOrder[stageNo - 1]});
    prevStageDiagnostics = prevStage.diagnostics;
    prevStageCacheDeps = prevStage.cacheDependencies;
    ast = prevStage.ast;
  }

  const context = new Context({
    ast,
    project,
    options,
    origin: {
      category: 'transform',
    },
  });

  const transformFactory = stageTransforms[stage];
  const transforms = transformFactory(project.config, options);

  let visitors: TransformVisitors = [
    ...hookVisitors,
    ...(await context.normalizeTransforms(transforms)),
  ];

  const compiledAst = program.assert(context.reduce(ast, visitors));

  const extractedSuppressions = extractSuppressionsFromProgram(ast);

  const res: TransformResult = {
    suppressions: extractedSuppressions.suppressions,
    diagnostics: [
      ...prevStageDiagnostics,
      ...context.diagnostics,
      ...extractedSuppressions.diagnostics,
    ],
    cacheDependencies: [
      ...prevStageCacheDeps,
      ...context.getCacheDependencies(),
    ],
    ast: compiledAst,
  };
  stageCache.set(cacheQuery, res);
  return res;
}
