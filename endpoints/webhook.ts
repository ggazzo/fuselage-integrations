import { IHttp, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiEndpoint, IApiEndpointInfo, IApiRequest, IApiResponse } from '@rocket.chat/apps-engine/definition/api';
import { IMessage } from '@rocket.chat/apps-engine/definition/messages';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { BlockElementType, IImageElement, TextObjectType } from '@rocket.chat/apps-engine/definition/uikit';


enum EVENT_TYPES {
    PULL_REQUEST = 'pull_request',
    PULL_REQUEST_REVIEW = 'pull_request_review',
}

type User = {
    login: string;
    avatar_url: string;
}

type PullRequest =  {
    html_url: string;
    url: string;
    title: string;
    body: string;
    user: User;
    number: number;
}


type Reviews = {
    id: string;
    state: 'APPROVED' | 'CHANGES_REQUESTED';
    user: User;
}

type GithubActionPullRequest = {
    action: 'opened' | 'edited' | 'closed' | 'assigned' | 'unassigned' | 'review_requested' | 'review_request_removed' | 'ready_for_review' | 'labeled' | 'unlabeled' | 'synchronize' | 'locked' | 'unlocked';
    number: number;
    pull_request: PullRequest;
}

type GithubActionPullRequestReview = {
    action: 'submitted' | 'dismissed';
    pull_request: PullRequest;
    review: {
        id: 'string';
        user: User
        state: 'approved';
    }
}

type PullRequestRelation = {
    mid: string;
}



export class WebHook extends ApiEndpoint {
    public path: string = 'webhook';
    public get(request: IApiRequest, endpoint: IApiEndpointInfo, read: IRead, modify: IModify, http: IHttp, persis: IPersistence) {
        this.app.getLogger().log(request);
        return this.success({ ok: true });
    }
    public async post(request: IApiRequest, endpoint: IApiEndpointInfo, read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<IApiResponse> {

        const room = await read.getRoomReader().getById('PdudbceedgKRq6qGX');

        if(!room) {
            return this.success({ ok: true });
        }

        const makeBlocks = (reviews: Reviews[], pr: PullRequest) => {
            const blockBuilder = modify.getCreator().getBlockBuilder();

            blockBuilder.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `*${ pr.title }* [#${pr.number}](${pr.url })
                    ${ pr.body }
                    `
                },
                accessory: {
                    type: BlockElementType.IMAGE,
                    imageUrl: pr.user.avatar_url,
                    altText: pr.user.login,
                }
            });

            if(reviews.length) {

                const appproved: IImageElement[] = reviews.filter(review => review.state ==='APPROVED' ).map(review => ({
                    type: BlockElementType.IMAGE,
                    imageUrl: review.user.avatar_url,
                    altText: review.user.login,
                }))

                appproved.length && blockBuilder.addContextBlock({ elements: [
                    {
                        type: TextObjectType.MARKDOWN,
                        text: "*Approved*"
                    },
                    ...appproved,
                ] })

                const changesRequested: IImageElement[] = reviews.filter(review => review.state === 'CHANGES_REQUESTED' ).map(review => ({
                    type: BlockElementType.IMAGE,
                    imageUrl: review.user.avatar_url,
                    altText: review.user.login,
                }));

                changesRequested.length && blockBuilder.addContextBlock({ elements: [
                    {
                        type: TextObjectType.MARKDOWN,
                        text: "*Changes Requested*"
                    },
                    ...changesRequested,
                ] })
            }

            return blockBuilder;
        }


        const fetchAndPersist = async (pull_request: PullRequest) => {
            const userApp = await read.getUserReader().getAppUser(this.app.getID());

                    if(!userApp) {
                        return;
                    }
                    const association = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, pull_request.number.toString());
                    const [pr] = await read.getPersistenceReader().readByAssociation(association) as Array<PullRequestRelation>;
                    const message = pr?.mid ? await (await modify.getUpdater().message(pr.mid, userApp)).setEditor(userApp) : await modify.getCreator().startMessage().setUsernameAlias('Fudelage')
                    .setEmojiAvatar(':fredgazzo:').setRoom(room);
                    const finisher = pr?.mid ? modify.getUpdater() : modify.getCreator();

                    const request = await (await http.get(`${pull_request.url}/reviews`, {
                        headers: {
                            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.96 Safari/537.36'
                        }
                    }));


                    const reviews: Reviews[] = request.data;
                    this.app.getLogger().log(reviews);

                    const blockBuilder = makeBlocks(reviews, pull_request);

                    message.setBlocks(blockBuilder);

                    const mid = await finisher.finish(message);

                    if(!pr) {
                        await persis.createWithAssociation({ mid }, association);
                    }
        }

        const handlePullRequest = async (): Promise<IApiResponse> => {
            const { action , pull_request }: GithubActionPullRequest = JSON.parse(request.content.payload);

            switch(action) {
                case 'opened':
                    await fetchAndPersist(pull_request);
                break;
            }
            return this.success({ ok: true });
        }

        const handlePullRequestReview = async (): Promise<IApiResponse> => {
            const { action, review , pull_request }: GithubActionPullRequestReview = JSON.parse(request.content.payload);


            switch(action) {
                case 'dismissed':
                case 'submitted':

                    await fetchAndPersist(pull_request);
                break;
            }
            return this.success({ ok: true });
        }

        if (request.headers['x-github-event'] === EVENT_TYPES.PULL_REQUEST) {
            return handlePullRequest();
        }
        if (request.headers['x-github-event'] === EVENT_TYPES.PULL_REQUEST_REVIEW) {
            return handlePullRequestReview();
        }
        this.app.getLogger().log(request);
        return this.success({ ok: true });
    }
}
